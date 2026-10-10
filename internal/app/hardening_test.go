package app

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestLoginSourceQuotaAndExpiry(t *testing.T) {
	s := testServer()
	now := time.Now()
	s.now = func() time.Time { return now }
	login := func(source, forwarded string) int {
		r := httptest.NewRequest("GET", "/auth/login", nil)
		r.RemoteAddr = source
		r.Header.Set("X-Forwarded-For", forwarded)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		return w.Code
	}
	for n := 0; n < 60; n++ {
		if code := login("192.0.2.1:1234", fmt.Sprint(n)); code != 302 {
			t.Fatal(code)
		}
	}
	if code := login("192.0.2.1:4321", "198.51.100.1"); code != 429 {
		t.Fatal("forwarded header bypass", code)
	}
	if len(s.transactions) != 60 {
		t.Fatal("unbounded transactions", len(s.transactions))
	}
	if code := login("192.0.2.2:1234", "192.0.2.1"); code != 302 {
		t.Fatal("independent source blocked", code)
	}
	now = now.Add(5 * time.Minute)
	if code := login("192.0.2.1:1234", ""); code != 302 {
		t.Fatal("quota did not expire", code)
	}
	if len(s.transactions) != 1 || len(s.loginLimits) != 1 {
		t.Fatal("expired state retained")
	}
	for _, pair := range [][2]string{{"[2001:db8::1]:1", "[2001:db8::2]:2"}, {"[::ffff:192.0.2.1]:1", "192.0.2.1:2"}} {
		a, b := httptest.NewRequest("GET", "/", nil), httptest.NewRequest("GET", "/", nil)
		a.RemoteAddr, b.RemoteAddr = pair[0], pair[1]
		if loginSource(a) != loginSource(b) {
			t.Fatal("source alias bypass")
		}
	}
}

func TestLoginQuotaMapBound(t *testing.T) {
	s := testServer()
	s.loginLimits = make(map[string]loginLimit)
	for n := 0; n < 2048; n++ {
		s.loginLimits[fmt.Sprint(n)] = loginLimit{1, s.now().Add(time.Minute)}
	}
	if w := request(s, nil, "GET", "/auth/login", nil); w.Code != 429 {
		t.Fatal(w.Code)
	}
	if len(s.loginLimits) != 2048 || len(s.transactions) != 0 {
		t.Fatal("capacity bound exceeded")
	}
}

func TestIdentitySessionQuotaAndReplacement(t *testing.T) {
	s := testServer()
	var first *session
	for n := 0; n < 5; n++ {
		ss := &session{ID: opaque(), Identity: identity{"issuer", "user"}, Expires: time.Now().Add(time.Hour)}
		if !s.storeSession(ss, "") {
			t.Fatal("session unexpectedly rejected")
		}
		if first == nil {
			first = ss
		}
	}
	next := &session{ID: opaque(), Identity: first.Identity, Expires: first.Expires}
	if s.storeSession(next, "") || s.storeSession(next, "nonexistent") {
		t.Fatal("identity quota bypass")
	}
	if !s.storeSession(next, first.ID) || len(s.sessions) != 5 || s.sessions[first.ID] != nil {
		t.Fatal("replacement failed")
	}
	other := &session{ID: opaque(), Identity: identity{"other-issuer", "user"}, Expires: first.Expires}
	if !s.storeSession(other, "") {
		t.Fatal("issuer not included in identity")
	}
}

func TestIdentityRoomQuotaAcrossSessions(t *testing.T) {
	for _, state := range []string{"host", "pending", "guest"} {
		t.Run(state, func(t *testing.T) {
			s := testServer()
			user, shadow, host := s.testUser("user"), s.testUser("user"), s.testUser("host")
			if state == "host" {
				create(t, s, user)
			} else {
				id, token := create(t, s, host)
				if join(s, user, id, token).Code != 200 {
					t.Fatal("join failed")
				}
				if state == "guest" {
					request(s, host, "POST", "/api/rooms/"+id+"/approve", nil)
				}
			}
			if request(s, shadow, "POST", "/api/rooms", nil).Code != 409 {
				t.Fatal("room quota bypass")
			}
			id, token := create(t, s, s.testUser("other"))
			if join(s, shadow, id, token).Code != 409 {
				t.Fatal("join quota bypass")
			}
			if s.rooms[id].Pending != nil {
				t.Fatal("failed join consumed slot")
			}
		})
	}
}

func TestCookieNamesAndAmbiguity(t *testing.T) {
	for _, secure := range []bool{false, true} {
		s := testServer()
		if secure {
			s.cfg.Origin = "https://quiet.example"
		}
		user := s.testUser("user")
		for _, name := range []string{"ql_session", "ql_login"} {
			for _, age := range []int{300, -1} {
				w := httptest.NewRecorder()
				s.cookie(w, name, "value", age)
				c := w.Result().Cookies()[0]
				expected := name
				if secure {
					expected = "__Host-" + name
				}
				if c.Name != expected || c.Secure != secure || c.Domain != "" || c.Path != "/" || !c.HttpOnly || c.SameSite != http.SameSiteLaxMode {
					t.Fatal("unsafe cookie attributes")
				}
			}
		}
		for _, path := range []string{"/api/me", "/auth/login", "/auth/callback"} {
			name := "ql_login"
			want := 400
			if path == "/api/me" {
				name, want = "ql_session", 401
			}
			for _, reverse := range []bool{false, true} {
				r := httptest.NewRequest("GET", path, nil)
				values := []string{user.ID, "other"}
				if reverse {
					values[0], values[1] = values[1], values[0]
				}
				for _, value := range values {
					r.AddCookie(&http.Cookie{Name: s.cookieName(name), Value: value})
				}
				w := httptest.NewRecorder()
				s.Handler().ServeHTTP(w, r)
				if w.Code != want {
					t.Fatal("ambiguous cookie accepted", path, w.Code)
				}
			}
		}
		if secure {
			r := httptest.NewRequest("GET", "/api/me", nil)
			r.AddCookie(&http.Cookie{Name: "ql_session", Value: user.ID})
			w := httptest.NewRecorder()
			s.Handler().ServeHTTP(w, r)
			if w.Code != 401 {
				t.Fatal("legacy cookie accepted over HTTPS")
			}
			r.AddCookie(&http.Cookie{Name: "__Host-ql_session", Value: user.ID})
			w = httptest.NewRecorder()
			s.Handler().ServeHTTP(w, r)
			if w.Code != 200 {
				t.Fatal("legacy cookie shadowed host cookie")
			}
		}
	}
}
