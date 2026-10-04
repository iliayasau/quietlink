package app

import (
	"context"
	"crypto/subtle"
	"net/http"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

func equal(a, b string) bool { return a != "" && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }
func (s *Server) cookie(w http.ResponseWriter, name, value string, age int) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: "/", MaxAge: age, HttpOnly: true, Secure: strings.HasPrefix(s.cfg.Origin, "https://"), SameSite: http.SameSiteLaxMode})
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if site := r.Header.Get("Sec-Fetch-Site"); site == "cross-site" {
		fail(w, 403, "Start sign-in from QuietLink.")
		return
	}
	s.mu.Lock()
	s.clean()
	if len(s.transactions) >= 1000 {
		s.mu.Unlock()
		fail(w, 429, "Sign-in is busy. Try again shortly.")
		return
	}
	key := opaque()
	tx := transaction{opaque(), opaque(), oauth2.GenerateVerifier(), s.now().Add(5 * time.Minute)}
	if old, err := r.Cookie("ql_login"); err == nil {
		delete(s.transactions, old.Value)
	}
	s.transactions[key] = tx
	s.mu.Unlock()
	s.cookie(w, "ql_login", key, 300)
	http.Redirect(w, r, s.oauth.AuthCodeURL(tx.State, oidc.Nonce(tx.Nonce), oauth2.S256ChallengeOption(tx.Verifier)), http.StatusFound)
}

func (s *Server) callback(w http.ResponseWriter, r *http.Request) {
	c, err := r.Cookie("ql_login")
	if err != nil {
		fail(w, 400, "Sign-in expired. Start again.")
		return
	}
	s.mu.Lock()
	tx, ok := s.transactions[c.Value]
	delete(s.transactions, c.Value)
	s.mu.Unlock()
	s.cookie(w, "ql_login", "", -1)
	if !ok || !tx.Expires.After(s.now()) || !equal(tx.State, r.URL.Query().Get("state")) || r.URL.Query().Get("code") == "" {
		fail(w, 400, "Sign-in expired or was not valid. Start again.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	ctx = oidc.ClientContext(ctx, s.httpClient)
	token, err := s.oauth.Exchange(ctx, r.URL.Query().Get("code"), oauth2.VerifierOption(tx.Verifier))
	if err != nil {
		fail(w, 401, "The identity provider could not complete sign-in.")
		return
	}
	raw, ok := token.Extra("id_token").(string)
	if !ok {
		fail(w, 401, "The identity provider did not return an identity.")
		return
	}
	id, err := s.verifier.Verify(ctx, raw)
	if err != nil || !equal(id.Nonce, tx.Nonce) || id.Subject == "" {
		fail(w, 401, "Identity verification failed.")
		return
	}
	var claims struct {
		Name string `json:"name"`
	}
	if err := id.Claims(&claims); err != nil {
		fail(w, 401, "Identity verification failed.")
		return
	}
	if claims.Name == "" {
		claims.Name = "QuietLink member"
	}
	if len(claims.Name) > 120 {
		claims.Name = "QuietLink member"
	}
	ss := &session{opaque(), identity{id.Issuer, id.Subject}, claims.Name, opaque(), s.now().Add(8 * time.Hour)}
	s.mu.Lock()
	s.clean()
	if len(s.sessions) >= 2000 {
		s.mu.Unlock()
		fail(w, 503, "QuietLink is at capacity. Try again later.")
		return
	}
	if old, err := r.Cookie("ql_session"); err == nil {
		s.revoke(old.Value)
	}
	s.sessions[ss.ID] = ss
	s.mu.Unlock()
	s.cookie(w, "ql_session", ss.ID, 8*3600)
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

// Call while holding mu; returned sessions must not escape the lock for mutation.
func (s *Server) authorize(w http.ResponseWriter, r *http.Request, mutation bool) *session {
	s.clean()
	c, err := r.Cookie("ql_session")
	if err != nil || s.sessions[c.Value] == nil {
		fail(w, 401, "Your session ended. Sign in again.")
		return nil
	}
	ss := s.sessions[c.Value]
	if mutation && (r.Header.Get("Origin") != s.cfg.Origin || !equal(r.Header.Get("X-CSRF-Token"), ss.CSRF)) {
		fail(w, 403, "Request could not be verified. Refresh and try again.")
		return nil
	}
	return ss
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ss := s.authorize(w, r, false)
	if ss == nil {
		return
	}
	var currentRoom any
	for _, rm := range s.rooms {
		if rm.member(ss) != nil || (rm.Pending != nil && rm.Pending.Session == ss.ID) {
			currentRoom = s.view(rm, ss)
			break
		}
	}
	reply(w, 200, map[string]any{"name": ss.Name, "csrf": ss.CSRF, "iceServers": s.cfg.ICE, "development": s.cfg.Development, "currentRoom": currentRoom})
}

func (s *Server) revoke(id string) {
	delete(s.sessions, id)
	for key, rm := range s.rooms {
		if rm.Host.Session == id {
			s.closeRoom(rm)
			delete(s.rooms, key)
			continue
		}
		if rm.Guest != nil && rm.Guest.Session == id {
			s.closeMember(rm.Guest)
			rm.Guest = nil
			s.notify(rm)
		}
		if rm.Pending != nil && rm.Pending.Session == id {
			rm.Pending = nil
		}
	}
}
func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ss := s.authorize(w, r, true)
	if ss == nil {
		return
	}
	s.revoke(ss.ID)
	s.cookie(w, "ql_session", "", -1)
	reply(w, 200, map[string]bool{"ok": true})
}
