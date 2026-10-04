// Package devissuer provides loopback-only test identities. It is not an account system.
package devissuer

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"html/template"
	"math/big"
	"net/http"
	"net/url"
	"sync"
	"time"
)

type authorization struct {
	Nonce, Challenge, Subject string
	Expires                   time.Time
}
type Issuer struct {
	URL, Redirect   string
	key             *rsa.PrivateKey
	mu              sync.Mutex
	requests, codes map[string]authorization
}

func New(issuer, redirect string) (*Issuer, error) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, err
	}
	return &Issuer{URL: issuer, Redirect: redirect, key: key, requests: map[string]authorization{}, codes: map[string]authorization{}}, nil
}
func random() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func jsonResponse(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
func (i *Issuer) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		jsonResponse(w, map[string]any{"issuer": i.URL, "authorization_endpoint": i.URL + "/authorize", "token_endpoint": i.URL + "/token", "jwks_uri": i.URL + "/keys", "response_types_supported": []string{"code"}, "subject_types_supported": []string{"public"}, "id_token_signing_alg_values_supported": []string{"RS256"}, "code_challenge_methods_supported": []string{"S256"}, "token_endpoint_auth_methods_supported": []string{"client_secret_basic", "client_secret_post"}})
	})
	mux.HandleFunc("GET /keys", func(w http.ResponseWriter, r *http.Request) {
		jsonResponse(w, map[string]any{"keys": []any{map[string]string{"kty": "RSA", "kid": "local-key", "use": "sig", "alg": "RS256", "n": base64.RawURLEncoding.EncodeToString(i.key.N.Bytes()), "e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(i.key.E)).Bytes())}}})
	})
	mux.HandleFunc("GET /authorize", i.authorize)
	mux.HandleFunc("POST /choose", i.choose)
	mux.HandleFunc("POST /token", i.token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		// Preserve a non-null Origin on the local HTML form POST, without query data.
		w.Header().Set("Referrer-Policy", "strict-origin")
		w.Header().Set("X-Frame-Options", "DENY")
		mux.ServeHTTP(w, r)
	})
}

var page = template.Must(template.New("login").Parse(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><title>QuietLink local identity provider</title><body><main><h1>Local test identities</h1><p>Development only. These names are test accounts, not verified people.</p><form method="post" action="/choose"><input type="hidden" name="request" value="{{.Request}}"><input type="hidden" name="state" value="{{.State}}"><label>Test identity <select name="identity"><option>Avery</option><option>Jordan</option><option>Sam</option></select></label><button>Continue to QuietLink</button></form></main></body></html>`))

func (i *Issuer) authorize(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if q.Get("client_id") != "quietlink-local" || q.Get("redirect_uri") != i.Redirect || q.Get("response_type") != "code" || q.Get("code_challenge_method") != "S256" || len(q.Get("code_challenge")) != 43 || q.Get("nonce") == "" || q.Get("state") == "" {
		http.Error(w, "Invalid local authorization", 400)
		return
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	i.clean()
	if len(i.requests) >= 1000 {
		http.Error(w, "Too many requests", 429)
		return
	}
	key := random()
	i.requests[key] = authorization{Nonce: q.Get("nonce"), Challenge: q.Get("code_challenge"), Expires: time.Now().Add(5 * time.Minute)}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = page.Execute(w, map[string]string{"Request": key, "State": q.Get("state")})
}
func (i *Issuer) clean() {
	for k, v := range i.requests {
		if time.Now().After(v.Expires) {
			delete(i.requests, k)
		}
	}
	for k, v := range i.codes {
		if time.Now().After(v.Expires) {
			delete(i.codes, k)
		}
	}
}
func (i *Issuer) choose(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") != i.URL {
		http.Error(w, "Invalid origin", 403)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	if r.ParseForm() != nil {
		http.Error(w, "Invalid form", 400)
		return
	}
	name := r.Form.Get("identity")
	if name != "Avery" && name != "Jordan" && name != "Sam" {
		http.Error(w, "Unknown test identity", 400)
		return
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	i.clean()
	a, ok := i.requests[r.Form.Get("request")]
	delete(i.requests, r.Form.Get("request"))
	if !ok {
		http.Error(w, "Expired request", 400)
		return
	}
	a.Subject = name
	code := random()
	i.codes[code] = a
	http.Redirect(w, r, i.Redirect+"?"+url.Values{"code": {code}, "state": {r.Form.Get("state")}}.Encode(), 303)
}
func (i *Issuer) token(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	if r.ParseForm() != nil {
		http.Error(w, "Invalid form", 400)
		return
	}
	client, _, ok := r.BasicAuth()
	if !ok {
		client = r.Form.Get("client_id")
	}
	i.mu.Lock()
	a, found := i.codes[r.Form.Get("code")]
	delete(i.codes, r.Form.Get("code"))
	i.mu.Unlock()
	h := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
	if client != "quietlink-local" || r.Form.Get("redirect_uri") != i.Redirect || r.Form.Get("grant_type") != "authorization_code" || !found || time.Now().After(a.Expires) || base64.RawURLEncoding.EncodeToString(h[:]) != a.Challenge {
		http.Error(w, "Invalid code", 400)
		return
	}
	header, _ := json.Marshal(map[string]string{"alg": "RS256", "kid": "local-key", "typ": "JWT"})
	claims, _ := json.Marshal(map[string]any{"iss": i.URL, "sub": a.Subject, "name": a.Subject, "aud": "quietlink-local", "iat": time.Now().Unix(), "exp": time.Now().Add(time.Minute).Unix(), "nonce": a.Nonce})
	body := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(claims)
	digest := sha256.Sum256([]byte(body))
	sig, err := rsa.SignPKCS1v15(rand.Reader, i.key, crypto.SHA256, digest[:])
	if err != nil {
		http.Error(w, "Signing failed", 500)
		return
	}
	jsonResponse(w, map[string]any{"access_token": random(), "token_type": "Bearer", "expires_in": 60, "id_token": body + "." + base64.RawURLEncoding.EncodeToString(sig)})
}
