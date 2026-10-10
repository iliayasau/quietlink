package app

import (
	"crypto/sha256"
	"net/http"
	"time"
)

type member struct {
	Session  string
	Identity identity
	Name     string
	Peer     *peer
}
type room struct {
	Epoch          uint64
	ID             string
	Host           *member
	Guest, Pending *member
	Invite         [32]byte
	InviteExpires  time.Time
	Expires        time.Time
}

func asMember(ss *session) *member {
	return &member{Session: ss.ID, Identity: ss.Identity, Name: ss.Name}
}
func (rm *room) member(ss *session) *member {
	if rm.Host.Session == ss.ID {
		return rm.Host
	}
	if rm.Guest != nil && rm.Guest.Session == ss.ID {
		return rm.Guest
	}
	return nil
}
func (rm *room) hasIdentity(who identity) bool {
	return rm.Host.Identity == who || (rm.Guest != nil && rm.Guest.Identity == who) || (rm.Pending != nil && rm.Pending.Identity == who)
}
func (s *Server) closeMember(m *member) {
	if m != nil && m.Peer != nil {
		m.Peer.cancel()
		m.Peer = nil
	}
}
func (s *Server) closeRoom(rm *room) { s.closeMember(rm.Host); s.closeMember(rm.Guest) }
func (s *Server) notify(rm *room) {
	rm.Epoch++
	for _, m := range []*member{rm.Host, rm.Guest} {
		if m != nil && m.Peer != nil {
			m.Peer.send(wire{Type: "reset", Epoch: rm.Epoch})
		}
	}
}
func (s *Server) view(rm *room, ss *session) map[string]any {
	role := "guest"
	status := "waiting"
	if rm.Host.Session == ss.ID {
		role = "host"
		status = "admitted"
	} else if rm.Guest != nil && rm.Guest.Session == ss.ID {
		status = "admitted"
	}
	view := map[string]any{"id": rm.ID, "role": role, "status": status, "host": rm.Host.Name, "expiresAt": rm.Expires}
	if rm.Guest != nil {
		view["guest"] = rm.Guest.Name
	}
	if role == "host" && rm.Pending != nil {
		view["pending"] = rm.Pending.Name
	}
	return view
}

func (s *Server) createRoom(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ss := s.authorize(w, r, true)
	if ss == nil {
		return
	}
	if len(s.rooms) >= 500 {
		fail(w, 503, "All rooms are occupied. Try again later.")
		return
	}
	for _, rm := range s.rooms {
		if rm.hasIdentity(ss.Identity) {
			fail(w, 409, "Leave your current room first.")
			return
		}
	}
	rm := &room{ID: opaque(), Host: asMember(ss), Expires: s.now().Add(2 * time.Hour)}
	token := opaque()
	rm.Invite = sha256.Sum256([]byte(token))
	rm.InviteExpires = s.now().Add(10 * time.Minute)
	s.rooms[rm.ID] = rm
	reply(w, 201, map[string]any{"room": s.view(rm, ss), "invite": rm.ID + "." + token, "inviteExpiresAt": rm.InviteExpires})
}

func (s *Server) joinRoom(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Room  string `json:"room"`
		Token string `json:"token"`
	}
	if !decode(w, r, &body) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ss := s.authorize(w, r, true)
	if ss == nil {
		return
	}
	rm := s.rooms[body.Room]
	if rm == nil || !rm.InviteExpires.After(s.now()) || rm.Invite != sha256.Sum256([]byte(body.Token)) {
		fail(w, 410, "This invitation is expired or already used. Ask the host for a new link.")
		return
	}
	if rm.Host.Identity == ss.Identity {
		fail(w, 409, "You are already the host of this room.")
		return
	}
	if rm.Guest != nil || rm.Pending != nil {
		fail(w, 409, "This room already has a guest.")
		return
	}
	for _, other := range s.rooms {
		if other.hasIdentity(ss.Identity) {
			fail(w, 409, "Leave your current room first.")
			return
		}
	}
	rm.Invite = [32]byte{}
	rm.InviteExpires = time.Time{}
	rm.Pending = asMember(ss)
	reply(w, 200, s.view(rm, ss))
}

func (s *Server) getRoom(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ss := s.authorize(w, r, false)
	if ss == nil {
		return
	}
	rm := s.rooms[r.PathValue("id")]
	if rm == nil || (rm.member(ss) == nil && (rm.Pending == nil || rm.Pending.Session != ss.ID)) {
		fail(w, 404, "The room ended or your request was declined.")
		return
	}
	reply(w, 200, s.view(rm, ss))
}

func (s *Server) mutateRoom(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ss := s.authorize(w, r, true)
	if ss == nil {
		return
	}
	rm := s.rooms[r.PathValue("id")]
	if rm == nil {
		fail(w, 404, "This room has ended.")
		return
	}
	action := r.PathValue("action")
	if action == "leave" {
		switch {
		case rm.Host.Session == ss.ID:
			s.closeRoom(rm)
			delete(s.rooms, rm.ID)
		case rm.Guest != nil && rm.Guest.Session == ss.ID:
			s.closeMember(rm.Guest)
			rm.Guest = nil
			s.notify(rm)
		case rm.Pending != nil && rm.Pending.Session == ss.ID:
			rm.Pending = nil
		default:
			fail(w, 403, "You do not belong to this room.")
			return
		}
		reply(w, 200, map[string]bool{"ok": true})
		return
	}
	if rm.Host.Session != ss.ID {
		fail(w, 403, "Only the host can manage this room.")
		return
	}
	switch action {
	case "approve":
		if rm.Pending == nil || rm.Guest != nil {
			fail(w, 409, "No guest is waiting for approval.")
			return
		}
		rm.Guest = rm.Pending
		rm.Pending = nil
	case "reject":
		if rm.Pending == nil {
			fail(w, 409, "No guest is waiting for approval.")
			return
		}
		rm.Pending = nil
	case "invite":
		if rm.Guest != nil || rm.Pending != nil {
			fail(w, 409, "This room already has a guest.")
			return
		}
		token := opaque()
		rm.Invite = sha256.Sum256([]byte(token))
		rm.InviteExpires = s.now().Add(10 * time.Minute)
		reply(w, 200, map[string]any{"invite": rm.ID + "." + token, "inviteExpiresAt": rm.InviteExpires})
		return
	default:
		fail(w, 404, "Unknown room action.")
		return
	}
	reply(w, 200, s.view(rm, ss))
}
