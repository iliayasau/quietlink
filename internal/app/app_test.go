package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/iliayasau/quietlink/internal/devissuer"
)

func testServer() *Server {
	return &Server{cfg:Config{Origin:"http://127.0.0.1:8080",Development:true},sessions:map[string]*session{},transactions:map[string]transaction{},rooms:map[string]*room{},now:time.Now}
}
func (s *Server) testUser(name string) *session {
	ss:=&session{ID:opaque(),Identity:identity{"test",name},Name:name,CSRF:opaque(),Expires:time.Now().Add(time.Hour)};s.sessions[ss.ID]=ss;return ss
}
func request(s *Server,ss *session,method,path string,body any) *httptest.ResponseRecorder {
	data,_:=json.Marshal(body);r:=httptest.NewRequest(method,path,bytes.NewReader(data))
	if ss!=nil {r.AddCookie(&http.Cookie{Name:"ql_session",Value:ss.ID});r.Header.Set("X-CSRF-Token",ss.CSRF)}
	r.Header.Set("Origin",s.cfg.Origin);w:=httptest.NewRecorder();s.Handler().ServeHTTP(w,r);return w
}
func create(t *testing.T,s *Server,host *session) (string,string) {
	t.Helper();w:=request(s,host,"POST","/api/rooms",nil);if w.Code!=201 {t.Fatal(w.Code,w.Body.String())}
	var v struct {Invite string `json:"invite"`};if err:=json.Unmarshal(w.Body.Bytes(),&v);err!=nil{t.Fatal(err)}
	parts:=strings.Split(v.Invite,".");return parts[0],parts[1]
}
func join(s *Server,guest *session,id,token string) *httptest.ResponseRecorder {return request(s,guest,"POST","/api/join",map[string]string{"room":id,"token":token})}

func TestInviteReplayApprovalAndThirdParticipant(t *testing.T) {
	s:=testServer();host,guest,third:=s.testUser("host"),s.testUser("guest"),s.testUser("third");id,token:=create(t,s,host)
	if w:=join(s,guest,id,token);w.Code!=200{t.Fatal(w.Code,w.Body.String())}
	if s.rooms[id].Guest!=nil {t.Fatal("pending guest was admitted")}
	if w:=join(s,third,id,token);w.Code!=410{t.Fatal("replayed invite accepted",w.Code)}
	if w:=request(s,guest,"POST","/api/rooms/"+id+"/approve",nil);w.Code!=403{t.Fatal("guest can approve")}
	if w:=request(s,host,"POST","/api/rooms/"+id+"/approve",nil);w.Code!=200{t.Fatal(w.Code)}
	if s.rooms[id].Guest.Session!=guest.ID{t.Fatal("wrong admitted guest")}
	if w:=request(s,host,"POST","/api/rooms/"+id+"/invite",nil);w.Code!=409{t.Fatal("third slot created")}
	if w:=request(s,third,"GET","/api/rooms/"+id,nil);w.Code!=404{t.Fatal("room leaked")}
}
func TestConcurrentInviteClaimIsAtomic(t *testing.T) {
	s:=testServer();host:=s.testUser("host");users:=make([]*session,24);for n:=range users{users[n]=s.testUser(fmt.Sprint(n))};id,token:=create(t,s,host)
	var admitted atomic.Int32;var wg sync.WaitGroup
	for _,user:=range users{wg.Add(1);go func(ss *session){defer wg.Done();if join(s,ss,id,token).Code==200{admitted.Add(1)}}(user)};wg.Wait()
	if admitted.Load()!=1{t.Fatalf("%d claims succeeded",admitted.Load())}
}
func TestExpiryRejectLeaveAndLogout(t *testing.T) {
	s:=testServer();host,guest:=s.testUser("host"),s.testUser("guest");id,token:=create(t,s,host)
	s.rooms[id].InviteExpires=time.Now().Add(-time.Second);if join(s,guest,id,token).Code!=410{t.Fatal("expired invite accepted")}
	w:=request(s,host,"POST","/api/rooms/"+id+"/invite",nil);var fresh struct{Invite string};_=json.Unmarshal(w.Body.Bytes(),&fresh);token=strings.Split(fresh.Invite,".")[1]
	if join(s,guest,id,token).Code!=200{t.Fatal("new invitation failed")}
	if request(s,host,"POST","/api/rooms/"+id+"/reject",nil).Code!=200{t.Fatal("reject failed")}
	if request(s,guest,"GET","/api/rooms/"+id,nil).Code!=404{t.Fatal("rejected guest retained access")}
	if request(s,host,"POST","/api/logout",nil).Code!=200{t.Fatal("logout failed")}
	if request(s,host,"GET","/api/me",nil).Code!=401 || len(s.rooms)!=0{t.Fatal("logout retained session or room")}
}
func TestOriginCSRFAndMalformedRequests(t *testing.T) {
	s:=testServer();ss:=s.testUser("host")
	for _,variant:=range []string{"origin","csrf","cookie"}{
		r:=httptest.NewRequest("POST","/api/rooms",nil);r.Header.Set("Origin",s.cfg.Origin);r.Header.Set("X-CSRF-Token",ss.CSRF)
		if variant!="cookie"{r.AddCookie(&http.Cookie{Name:"ql_session",Value:ss.ID})};if variant=="origin"{r.Header.Set("Origin","https://evil.invalid")};if variant=="csrf"{r.Header.Set("X-CSRF-Token","wrong")}
		w:=httptest.NewRecorder();s.Handler().ServeHTTP(w,r);if w.Code!=403 && w.Code!=401{t.Fatal(variant,w.Code)}
	}
	for _,body:=range []string{`{"room":"x","unknown":true}`,`{} {}`,strings.Repeat("x",9000)}{
		r:=httptest.NewRequest("POST","/api/join",strings.NewReader(body));w:=httptest.NewRecorder();s.Handler().ServeHTTP(w,r);if w.Code!=400{t.Fatal("malformed request accepted")}
	}
}
func TestMalformedSignaling(t *testing.T) {
	for _,raw:=range []string{`{}`,`{"type":"offer"}`,`{"type":"ready","sdp":"x"}`,`{"type":"candidate","candidate":null}`,`{"type":"candidate","candidate":{"candidate":"x","extra":1}}`,`{"type":"ready"} {}`,`{"type":"logout"}`} {if _,err:=parseWire([]byte(raw));err==nil{t.Fatalf("accepted %s",raw)}}
	for _,raw:=range []string{`{"type":"ready"}`,`{"type":"offer","sdp":"v=0"}`,`{"type":"candidate","candidate":{"candidate":"candidate:x","sdpMid":"0","sdpMLineIndex":0}}`}{if _,err:=parseWire([]byte(raw));err!=nil{t.Fatal(err)}}
}
func TestProductionConfigAndSecureCookie(t *testing.T) {
	cfg:=Config{Origin:"https://quiet.example",Issuer:"https://issuer.example",ClientID:"client"};if cfg.Validate()!=nil{t.Fatal("valid config rejected")}
	for _,bad:=range []Config{{Origin:"http://quiet.example",Issuer:cfg.Issuer,ClientID:"client"},{Origin:cfg.Origin,Issuer:"http://localhost:9090",ClientID:"client"},{Origin:cfg.Origin,Issuer:cfg.Issuer,ClientID:"quietlink-local"}}{if bad.Validate()==nil{t.Fatal("insecure configuration accepted")}}
	s:=testServer();s.cfg.Development=false;w:=httptest.NewRecorder();s.cookie(w,"ql_session","value",60);c:=w.Result().Cookies()[0]
	if !c.Secure || !c.HttpOnly || c.SameSite!=http.SameSiteLaxMode{t.Fatal("unsafe session cookie")}
}
func TestSessionAndRoomExpiry(t *testing.T) {
	s:=testServer();ss:=s.testUser("host");id,_:=create(t,s,ss);s.rooms[id].Expires=time.Now().Add(-time.Second)
	if request(s,ss,"GET","/api/rooms/"+id,nil).Code!=404{t.Fatal("expired room accessible")}
	ss.Expires=time.Now().Add(-time.Second);if request(s,ss,"GET","/api/me",nil).Code!=401{t.Fatal("expired session accepted")}
}

func TestWebSocketAuthorizationRelayAndRevocation(t *testing.T) {
	s:=testServer();host,guest,third:=s.testUser("host"),s.testUser("guest"),s.testUser("third");id,token:=create(t,s,host);_=join(s,guest,id,token)
	httpServer:=httptest.NewServer(s.Handler());defer httpServer.Close();s.cfg.Origin=httpServer.URL
	ctx,cancel:=context.WithTimeout(context.Background(),5*time.Second);defer cancel()
	dial:=func(ss *session,origin string)(*websocket.Conn,*http.Response,error){return websocket.Dial(ctx,"ws"+strings.TrimPrefix(httpServer.URL,"http")+"/api/rooms/"+id+"/signal",&websocket.DialOptions{HTTPHeader:http.Header{"Origin":{origin},"Cookie":{"ql_session="+ss.ID}}})}
	for _,ss:=range []*session{guest,third}{c,r,err:=dial(ss,httpServer.URL);if err==nil{c.CloseNow();t.Fatal("nonmember connected")};if r==nil||r.StatusCode!=403{t.Fatal("wrong unauthorized response")}}
	if c,_,err:=dial(host,"https://evil.invalid");err==nil{c.CloseNow();t.Fatal("cross-origin socket accepted")}
	_=request(s,host,"POST","/api/rooms/"+id+"/approve",nil)
	hc,_,err:=dial(host,httpServer.URL);if err!=nil{t.Fatal(err)};defer hc.CloseNow()
	gc,_,err:=dial(guest,httpServer.URL);if err!=nil{t.Fatal(err)};defer gc.CloseNow()
	if err=gc.Write(ctx,websocket.MessageText,[]byte(`{"type":"ready"}`));err!=nil{t.Fatal(err)}
	for {_,data,err:=hc.Read(ctx);if err!=nil{t.Fatal(err)};if strings.Contains(string(data),"ready"){break}}
	if request(s,guest,"POST","/api/logout",nil).Code!=200{t.Fatal("logout failed")}
	// Draining the queued reset must eventually reach a closed connection.
	for {if _,_,err:=gc.Read(ctx);err!=nil{break}}
	s.mu.Lock();left:=s.rooms[id].Guest;s.mu.Unlock();if left!=nil{t.Fatal("guest retained admission after logout")}
}

func TestOIDCLoginNonceAndReplay(t *testing.T) {
	for _,wrongNonce:=range []bool{false,true}{t.Run(fmt.Sprint("wrongNonce=",wrongNonce),func(t *testing.T){
		i,err:=devissuer.New("","");if err!=nil{t.Fatal(err)};issuer:=httptest.NewServer(i.Handler());defer issuer.Close();i.URL=issuer.URL
		appHTTP:=httptest.NewUnstartedServer(nil);appHTTP.Start();defer appHTTP.Close();i.Redirect=appHTTP.URL+"/auth/callback"
		s,err:=New(context.Background(),Config{Origin:appHTTP.URL,Issuer:issuer.URL,ClientID:"quietlink-local",Development:true});if err!=nil{t.Fatal(err)};appHTTP.Config.Handler=s.Handler()
		jar,_:=cookiejar.New(nil);client:=&http.Client{Jar:jar,CheckRedirect:func(r *http.Request,via []*http.Request)error{return http.ErrUseLastResponse},Timeout:5*time.Second}
		get:=func(raw string)*http.Response{resp,err:=client.Get(raw);if err!=nil{t.Fatal(err)};t.Cleanup(func(){resp.Body.Close()});return resp}
		login:=get(appHTTP.URL+"/auth/login");if login.StatusCode!=302{t.Fatal("login failed")}
		choosePage:=get(login.Header.Get("Location"));html,_:=io.ReadAll(choosePage.Body)
		field:=func(name string)string{match:=regexp.MustCompile(`name="`+name+`" value="([^"]+)"`).FindStringSubmatch(string(html));if len(match)!=2{t.Fatal("missing form field",name)};return match[1]}
		form:=url.Values{"request":{field("request")},"state":{field("state")},"identity":{"Avery"}}
		r,_:=http.NewRequest("POST",issuer.URL+"/choose",strings.NewReader(form.Encode()));r.Header.Set("Content-Type","application/x-www-form-urlencoded");r.Header.Set("Origin",issuer.URL)
		choice,err:=client.Do(r);if err!=nil{t.Fatal(err)};choice.Body.Close();callbackURL:=choice.Header.Get("Location")
		if wrongNonce{s.mu.Lock();for key,tx:=range s.transactions{tx.Nonce="wrong";s.transactions[key]=tx};s.mu.Unlock()}
		callback:=get(callbackURL);want:=303;if wrongNonce{want=401};if callback.StatusCode!=want{body,_:=io.ReadAll(callback.Body);t.Fatal(callback.StatusCode,string(body))}
		if get(callbackURL).StatusCode!=400{t.Fatal("callback replay accepted")}
		me:=get(appHTTP.URL+"/api/me");if !wrongNonce && me.StatusCode!=200{t.Fatal("session missing")};if wrongNonce && me.StatusCode!=401{t.Fatal("nonce mismatch created a session")}
	})}
}
