package app

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

type identity struct{ Issuer, Subject string }
type session struct {
	ID       string
	Identity identity
	Name     string
	CSRF     string
	Expires  time.Time
}
type transaction struct {
	State, Nonce, Verifier string
	Expires                time.Time
}
type Server struct {
	cfg          Config
	mu           sync.Mutex
	sessions     map[string]*session
	transactions map[string]transaction
	rooms        map[string]*room
	oauth        oauth2.Config
	verifier     *oidc.IDTokenVerifier
	httpClient   *http.Client
	now          func() time.Time
}

func New(ctx context.Context, cfg Config) (*Server, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: 10 * time.Second}
	ctx = oidc.ClientContext(ctx, client)
	provider, err := oidc.NewProvider(ctx, cfg.Issuer)
	if err != nil {
		return nil, err
	}
	s := &Server{cfg: cfg, sessions: map[string]*session{}, transactions: map[string]transaction{}, rooms: map[string]*room{}, now: time.Now, httpClient: client}
	s.oauth = oauth2.Config{ClientID: cfg.ClientID, ClientSecret: cfg.ClientSecret, RedirectURL: cfg.Origin + "/auth/callback", Endpoint: provider.Endpoint(), Scopes: []string{oidc.ScopeOpenID, "profile"}}
	s.verifier = provider.Verifier(&oidc.Config{ClientID: cfg.ClientID, SupportedSigningAlgs: []string{"RS256", "ES256"}})
	return s, nil
}

func opaque() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("operating system entropy unavailable")
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { reply(w, 200, map[string]string{"status": "ok"}) })
	mux.HandleFunc("GET /auth/login", s.login)
	mux.HandleFunc("GET /auth/callback", s.callback)
	mux.HandleFunc("GET /api/me", s.me)
	mux.HandleFunc("POST /api/logout", s.logout)
	mux.HandleFunc("POST /api/rooms", s.createRoom)
	mux.HandleFunc("POST /api/join", s.joinRoom)
	mux.HandleFunc("GET /api/rooms/{id}", s.getRoom)
	mux.HandleFunc("POST /api/rooms/{id}/{action}", s.mutateRoom)
	mux.HandleFunc("GET /api/rooms/{id}/signal", s.signal)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "HEAD" {
			http.Error(w, "method not allowed", 405)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/auth/") {
			http.NotFound(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			http.FileServer(http.Dir(s.cfg.Static)).ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(s.cfg.Static, "index.html"))
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self' data:; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' "+strings.Replace(s.cfg.Origin, "http", "ws", 1)+"; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		if !s.cfg.Development {
			w.Header().Set("Strict-Transport-Security", "max-age=31536000")
		}
		mux.ServeHTTP(w, r)
	})
}

func reply(w http.ResponseWriter, code int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(value)
}
func fail(w http.ResponseWriter, code int, message string) {
	reply(w, code, map[string]string{"error": message})
}
func decode(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		fail(w, 400, "Invalid request.")
		return false
	}
	if err := d.Decode(new(any)); err != io.EOF {
		fail(w, 400, "Invalid request.")
		return false
	}
	return true
}

// All callers hold mu. Cleanup bounds expired state and revokes active room access.
func (s *Server) clean() {
	now := s.now()
	for key, tx := range s.transactions {
		if !tx.Expires.After(now) {
			delete(s.transactions, key)
		}
	}
	for key, ss := range s.sessions {
		if !ss.Expires.After(now) {
			s.revoke(key)
		}
	}
	for key, room := range s.rooms {
		if !room.Expires.After(now) {
			s.closeRoom(room)
			delete(s.rooms, key)
		}
	}
}

func (s *Server) Sweep(ctx context.Context) {
	t := time.NewTicker(15 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			s.mu.Lock()
			for _, room := range s.rooms {
				s.closeRoom(room)
			}
			s.mu.Unlock()
			return
		case <-t.C:
			s.mu.Lock()
			s.clean()
			s.mu.Unlock()
		}
	}
}
