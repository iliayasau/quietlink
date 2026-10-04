package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

type wire struct {
	Epoch     uint64          `json:"epoch,omitempty"`
	Type      string          `json:"type"`
	SDP       string          `json:"sdp,omitempty"`
	Candidate json.RawMessage `json:"candidate,omitempty"`
}
type peer struct {
	queue  chan wire
	cancel context.CancelFunc
}

func (p *peer) send(msg wire) {
	select {
	case p.queue <- msg:
	default:
		p.cancel()
	}
}

func parseWire(data []byte) (wire, error) {
	var msg wire
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(&msg); err != nil {
		return msg, err
	}
	if d.Decode(new(any)) != io.EOF {
		return msg, errors.New("trailing data")
	}
	switch msg.Type {
	case "ready":
		if msg.SDP != "" || len(msg.Candidate) > 0 {
			return msg, errors.New("invalid ready")
		}
	case "offer", "answer":
		if len(msg.SDP) < 1 || len(msg.SDP) > 60000 || len(msg.Candidate) > 0 {
			return msg, errors.New("invalid description")
		}
	case "candidate":
		if msg.SDP != "" || len(msg.Candidate) > 4096 {
			return msg, errors.New("invalid candidate")
		}
		var c struct {
			Candidate        string  `json:"candidate"`
			SDPMid           *string `json:"sdpMid"`
			SDPMLineIndex    *uint16 `json:"sdpMLineIndex"`
			UsernameFragment *string `json:"usernameFragment"`
		}
		cd := json.NewDecoder(bytes.NewReader(msg.Candidate))
		cd.DisallowUnknownFields()
		if err := cd.Decode(&c); err != nil || c.Candidate == "" {
			return msg, errors.New("invalid candidate")
		}
	default:
		return msg, errors.New("unknown signaling type")
	}
	return msg, nil
}

func (s *Server) signal(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") != s.cfg.Origin {
		fail(w, 403, "Untrusted origin.")
		return
	}
	s.mu.Lock()
	ss := s.authorize(w, r, false)
	if ss == nil {
		s.mu.Unlock()
		return
	}
	rm := s.rooms[r.PathValue("id")]
	if rm == nil || rm.member(ss) == nil {
		s.mu.Unlock()
		fail(w, 403, "Room admission required.")
		return
	}
	sid, rid := ss.ID, rm.ID
	s.mu.Unlock()
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{s.cfg.Origin}})
	if err != nil {
		return
	}
	defer c.CloseNow()
	c.SetReadLimit(65536)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := &peer{make(chan wire, 32), cancel}
	s.mu.Lock()
	rm = s.rooms[rid]
	ss = s.sessions[sid]
	if rm == nil || ss == nil || rm.member(ss) == nil {
		s.mu.Unlock()
		return
	}
	m := rm.member(ss)
	if m.Peer != nil {
		s.mu.Unlock()
		_ = c.Close(websocket.StatusTryAgainLater, "room already open in another connection")
		return
	}
	m.Peer = p
	s.notify(rm)
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if rm := s.rooms[rid]; rm != nil {
			if ss := s.sessions[sid]; ss != nil {
				if m := rm.member(ss); m != nil && m.Peer == p {
					m.Peer = nil
					s.notify(rm)
				}
			}
		}
	}()
	go func() {
		defer cancel()
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case msg := <-p.queue:
				data, _ := json.Marshal(msg)
				wc, stop := context.WithTimeout(ctx, 5*time.Second)
				err := c.Write(wc, websocket.MessageText, data)
				stop()
				if err != nil {
					return
				}
			case <-ticker.C:
				pc, stop := context.WithTimeout(ctx, 5*time.Second)
				err := c.Ping(pc)
				stop()
				if err != nil {
					return
				}
			}
		}
	}()
	window, count := time.Now(), 0
	for {
		typ, data, err := c.Read(ctx)
		if err != nil {
			return
		}
		if time.Since(window) >= time.Second {
			window = time.Now()
			count = 0
		}
		count++
		if count > 80 || typ != websocket.MessageText {
			_ = c.Close(websocket.StatusPolicyViolation, "signaling limit")
			return
		}
		msg, err := parseWire(data)
		if err != nil {
			_ = c.Close(websocket.StatusPolicyViolation, "invalid signaling message")
			return
		}
		s.mu.Lock()
		s.clean()
		rm = s.rooms[rid]
		ss = s.sessions[sid]
		if rm == nil || ss == nil || rm.member(ss) == nil || rm.member(ss).Peer != p {
			s.mu.Unlock()
			return
		}
		if msg.Epoch != rm.Epoch {
			s.mu.Unlock()
			continue
		}
		isHost := rm.Host.Session == sid
		if (msg.Type == "offer" && !isHost) || ((msg.Type == "answer" || msg.Type == "ready") && isHost) {
			s.mu.Unlock()
			_ = c.Close(websocket.StatusPolicyViolation, "invalid signaling role")
			return
		}
		target := rm.Host
		if isHost {
			target = rm.Guest
		}
		if target != nil && target.Peer != nil {
			target.Peer.send(msg)
		}
		s.mu.Unlock()
	}
}
