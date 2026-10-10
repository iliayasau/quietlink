import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  Copy,
  Headphones,
  Link,
  LockKeyhole,
  LogOut,
  Mic,
  MicOff,
  PhoneOff,
  RefreshCw,
  ShieldCheck,
  Video,
  VideoOff,
  X,
} from "lucide-react";
import { api, APIError, type Account, type Room } from "./api";
import { useCall } from "./useCall";

function VideoFeed({
  stream,
  local = false,
}: {
  stream: MediaStream | null;
  local?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.srcObject = stream;
      void ref.current.play().catch(() => {});
    }
  }, [stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={local}
      className={local ? "mirror" : ""}
      aria-label={local ? "Your camera preview" : "Guest video"}
    />
  );
}

export function App() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [restoreFailed, setRestoreFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [room, setRoom] = useState<Room | null>(null);
  const [invite, setInvite] = useState("");
  const [incoming, setIncoming] = useState(() => {
    const token = new URLSearchParams(location.hash.slice(1)).get("invite");
    if (token) {
      sessionStorage.setItem("ql_invite", token);
      history.replaceState(null, "", "/");
    }
    return sessionStorage.getItem("ql_invite") ?? "";
  });
  useEffect(() => {
    const receiveInvitation = () => {
      const token = new URLSearchParams(location.hash.slice(1)).get("invite");
      if (!token) return;
      sessionStorage.setItem("ql_invite", token);
      history.replaceState(null, "", "/");
      setIncoming(token);
    };
    window.addEventListener("hashchange", receiveInvitation);
    return () => window.removeEventListener("hashchange", receiveInvitation);
  }, []);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mounted = useRef(true);
  const mediaGeneration = useRef(0);
  const [mic, setMic] = useState(true);
  const [camera, setCamera] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const ice = useMemo(() => account?.iceServers ?? [], [account]);
  const call = useCall(room, stream, ice, attempt);
  const stopMedia = () => {
    mediaGeneration.current++;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);
  };
  const clearRoom = () => {
    setRoom(null);
    setInvite("");
    sessionStorage.removeItem("ql_room");
    stopMedia();
  };

  useEffect(() => {
    mounted.current = true;
    void loadAccount();
    return () => {
      mounted.current = false;
      mediaGeneration.current++;
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  function restoreRoom(value: Room) {
    remember(value);
    if (
      value.role === "guest" &&
      sessionStorage.getItem("ql_invite")?.startsWith(`${value.id}.`)
    ) {
      sessionStorage.removeItem("ql_invite");
      setIncoming("");
    }
  }

  async function loadAccount() {
    setLoading(true);
    setRestoreFailed(false);
    setError("");
    try {
      const me = await api<Account>("/api/me");
      if (!mounted.current) return;
      setAccount(me);
      if (me.currentRoom) restoreRoom(me.currentRoom);
      else clearRoom(); // An authenticated server snapshot confirms no membership.
    } catch (e) {
      if (!mounted.current) return;
      if (e instanceof APIError && e.status === 401) {
        setAccount(null);
        clearRoom();
      } else {
        // A timeout or server error is not evidence that the room has ended.
        setRestoreFailed(true);
        setError(
          "QuietLink could not restore your session. Your saved room has been kept. Try again.",
        );
      }
    } finally {
      if (mounted.current) setLoading(false);
    }
  }

  async function recoverMembership() {
    let me: Account;
    try {
      me = await api<Account>("/api/me");
    } catch (e) {
      if (e instanceof APIError && e.status === 401) throw e;
      throw new Error(
        "Your request may have reached the server. Try again or refresh to recover your room when the connection is back.",
        { cause: e },
      );
    }
    if (!me.currentRoom) return false;
    setAccount(me);
    restoreRoom(me.currentRoom);
    setNotice(
      me.currentRoom.role === "host"
        ? "Your room was restored. Create a new invitation to share it."
        : me.currentRoom.status === "waiting"
          ? "Your room request was restored. Host approval is still required before joining."
          : "Your admitted room was restored.",
    );
    return true;
  }

  useEffect(() => {
    if (!room) return;
    let active = true;
    const timer = setInterval(() => {
      void api<Room>(`/api/rooms/${room.id}`)
        .then((value) => {
          if (active) setRoom(value);
        })
        .catch((e) => {
          if (!active) return;
          if (e instanceof APIError && (e.status === 404 || e.status === 401)) {
            clearRoom();
            setError(e.message);
            if (e.status === 401) setAccount(null);
          } else
            setError(
              "Connection interrupted. Checking your room again shortly.",
            );
        });
    }, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [room?.id]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Something went wrong. Try again.",
      );
      if (e instanceof APIError && e.status === 401) {
        clearRoom();
        setAccount(null);
      }
    } finally {
      setBusy(false);
    }
  }
  async function preview() {
    const generation = ++mediaGeneration.current;
    await run(async () => {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error(
          "Camera access requires HTTPS or localhost and a supported browser.",
        );
      try {
        const media = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            facingMode: "user",
          },
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        if (!mounted.current || generation !== mediaGeneration.current) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = media;
        setStream(media);
        setMic(true);
        setCamera(true);
      } catch {
        if (!mounted.current || generation !== mediaGeneration.current) return;
        throw new Error(
          "Camera or microphone unavailable. Allow access in your browser, close other camera apps, then try again.",
        );
      }
    });
  }
  function toggle(kind: "audio" | "video") {
    stream
      ?.getTracks()
      .filter((track) => track.kind === kind)
      .forEach((track) => {
        track.enabled = !track.enabled;
      });
    if (kind === "audio") setMic(!mic);
    else setCamera(!camera);
  }
  function remember(value: Room) {
    setRoom(value);
    sessionStorage.setItem("ql_room", value.id);
  }
  async function createRoom() {
    if (!account) return;
    await run(async () => {
      try {
        const result = await api<{ room: Room; invite: string }>(
          "/api/rooms",
          account.csrf,
          {},
        );
        remember(result.room);
        setInvite(`${location.origin}/#invite=${result.invite}`);
      } catch (e) {
        if (await recoverMembership()) return;
        throw e;
      }
    });
  }
  async function joinRoom() {
    if (!account) return;
    await run(async () => {
      const parts = incoming.split(".");
      if (parts.length !== 2)
        throw new Error(
          "This invitation is incomplete. Ask your host for a new link.",
        );
      try {
        remember(
          await api<Room>("/api/join", account.csrf, {
            room: parts[0],
            token: parts[1],
          }),
        );
        sessionStorage.removeItem("ql_invite");
        setIncoming("");
      } catch (e) {
        if (await recoverMembership()) return;
        throw e;
      }
    });
  }
  async function action(name: string) {
    if (!account || !room) return;
    await run(async () => {
      const result = await api<Room & { invite?: string }>(
        `/api/rooms/${room.id}/${name}`,
        account.csrf,
        {},
      );
      if (name === "invite") {
        setInvite(`${location.origin}/#invite=${result.invite}`);
        setNotice("New invitation ready. Previous links no longer work.");
      } else setRoom(result);
    });
  }
  async function hangup() {
    stopMedia();
    if (!account || !room) return;
    await run(async () => {
      await api(`/api/rooms/${room.id}/leave`, account.csrf, {});
      clearRoom();
      setNotice("You left the room. Your camera and microphone are off.");
    });
  }
  async function logout() {
    if (!account) return;
    stopMedia();
    await run(async () => {
      await api("/api/logout", account.csrf, {});
      clearRoom();
      setAccount(null);
      setNotice("You are signed out of QuietLink.");
    });
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="QuietLink home">
          <span className="brand-mark">
            <span />
            <span />
          </span>
          QuietLink<span className="brand-dot">.</span>
        </a>
        <span className="header-note">
          <span className="status-dot" /> Less noise. More connection.
        </span>
        {account ? (
          <button
            className="text-button"
            onClick={() => void logout()}
            disabled={busy}
          >
            <LogOut size={16} /> Sign out
          </button>
        ) : (
          <span className="header-lock">
            <LockKeyhole size={15} /> Just you two
          </span>
        )}
      </header>
      <main>
        <div className="page-heading">
          <div>
            <p className="eyebrow">A LITTLE SPACE TO CONNECT</p>
            <h1>
              {room
                ? "You’re in good company."
                : incoming
                  ? "Someone saved you a seat."
                  : "A room for two."}
            </h1>
            <p className="subtitle">
              {room
                ? "Settle in. The conversation is yours."
                : "A little more presence. A little less noise."}
            </p>
          </div>
          <span className="private-badge">
            <ShieldCheck size={17} /> Invitation only
          </span>
        </div>
        {error && (
          <div className="message error" role="alert">
            <span>{error}</span>
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <X size={18} />
            </button>
          </div>
        )}
        {notice && (
          <div className="message" role="status">
            {notice}
          </div>
        )}
        <div className="workspace">
          <section className="stage" aria-label="Video room">
            <div className="stage-top">
              <span className="live-tag">
                <span
                  className={
                    call.state === "Connected" ? "status-dot" : "neutral-dot"
                  }
                />{" "}
                {room ? "YOUR PRIVATE ROOM" : "YOUR SPACE"}
              </span>
              <span className="stage-counter">
                {room?.guest ? "02" : "01"} <span>/ 02</span>
              </span>
            </div>
            <div className={`video-area ${call.remote ? "has-remote" : ""}`}>
              {call.remote ? (
                <VideoFeed stream={call.remote} />
              ) : stream && camera ? (
                <VideoFeed stream={stream} local />
              ) : (
                <div className="empty-preview">
                  <div className="orbit orbit-one" />
                  <div className="orbit orbit-two" />
                  <div className="camera-symbol">
                    <Video size={34} strokeWidth={1.25} />
                  </div>
                  <h2>
                    {stream ? "Camera is off" : "Make yourself comfortable."}
                  </h2>
                  <p>
                    {stream
                      ? "You can turn it back on anytime."
                      : "Check your camera and microphone before you join."}
                  </p>
                  {account && !stream && (
                    <button
                      className="light-button"
                      onClick={() => void preview()}
                      disabled={busy}
                    >
                      <Video size={17} /> Enable camera & microphone
                    </button>
                  )}
                </div>
              )}
              {call.remote && (
                <div className="self-preview">
                  {camera ? (
                    <VideoFeed stream={stream} local />
                  ) : (
                    <VideoOff size={24} />
                  )}
                  <span>You</span>
                </div>
              )}
              <div className="video-caption">
                <span>
                  {call.remote
                    ? room?.role === "host"
                      ? room.guest
                      : room?.host
                    : account
                      ? `${account.name} (you)`
                      : "Your preview"}
                </span>
                <span>
                  {room ? call.state : stream ? "Looking good" : "Camera off"}
                </span>
              </div>
            </div>
            <div className="call-controls">
              <div className="controls-left">
                <button
                  className={`control ${!mic && stream ? "off" : ""}`}
                  aria-label={mic ? "Mute microphone" : "Unmute microphone"}
                  aria-pressed={!mic}
                  disabled={!stream}
                  onClick={() => toggle("audio")}
                >
                  {mic ? <Mic size={21} /> : <MicOff size={21} />}
                </button>
                <button
                  className={`control ${!camera && stream ? "off" : ""}`}
                  aria-label={camera ? "Turn camera off" : "Turn camera on"}
                  aria-pressed={!camera}
                  disabled={!stream}
                  onClick={() => toggle("video")}
                >
                  {camera ? <Video size={22} /> : <VideoOff size={22} />}
                </button>
              </div>
              <p className="connection-label" role="status">
                {room ? call.state : "Ready when you are"}
              </p>
              {room ? (
                <button
                  className="hangup"
                  onClick={() => void hangup()}
                  disabled={busy}
                >
                  <PhoneOff size={19} />
                  <span>Leave</span>
                </button>
              ) : (
                <span className="stage-lock">
                  <LockKeyhole size={18} />
                </span>
              )}
            </div>
          </section>
          <aside className="side-panel">
            <span className="panel-step">
              {room ? "THE CONVERSATION" : "BEFORE YOU BEGIN"}
              <span>{room ? "02" : "01"}</span>
            </span>
            {loading ? (
              <>
                <h2>Getting your space ready…</h2>
                <p>Please wait a moment.</p>
              </>
            ) : restoreFailed ? (
              <>
                <h2>Let’s reconnect.</h2>
                <p>
                  We could not check your room. Try again when your connection
                  is back.
                </p>
                <button
                  className="primary-button"
                  onClick={() => void loadAccount()}
                >
                  Try again <RefreshCw size={18} />
                </button>
              </>
            ) : !account ? (
              <>
                <h2>
                  Good conversations
                  <br />
                  start with trust.
                </h2>
                <p>
                  Sign in with your identity provider, then invite one person
                  into your private room.
                </p>
                <a className="primary-button" href="/auth/login">
                  Sign in to continue <ArrowRight size={18} />
                </a>
                <div className="fine-print">
                  <LockKeyhole size={15} />
                  <span>Your camera stays off until you enable it.</span>
                </div>
              </>
            ) : !room ? (
              <>
                <h2>
                  {incoming
                    ? "An invitation, just for you."
                    : `Hello, ${account.name}.`}
                </h2>
                <p>
                  {incoming
                    ? "Check your preview, then ask to join. Your host will let you in."
                    : "Check your preview, create a room, and share a one-time invitation."}
                </p>
                <ol className="steps">
                  <li className={stream ? "complete" : ""}>
                    <span>{stream ? <Check size={14} /> : "1"}</span>Get
                    camera-ready
                  </li>
                  <li>
                    <span>2</span>
                    {incoming ? "Ask your host to join" : "Invite your person"}
                  </li>
                  <li>
                    <span>3</span>Enjoy the conversation
                  </li>
                </ol>
                <button
                  className="primary-button"
                  disabled={!stream || busy}
                  onClick={() => void (incoming ? joinRoom() : createRoom())}
                >
                  {incoming ? "Request to join" : "Create a private room"}
                  <ArrowRight size={18} />
                </button>
                {!stream && (
                  <p className="small-note">
                    Enable your camera and microphone to continue.
                  </p>
                )}
                {incoming && (
                  <button
                    className="text-button"
                    onClick={() => {
                      sessionStorage.removeItem("ql_invite");
                      setIncoming("");
                    }}
                  >
                    Discard invitation
                  </button>
                )}
              </>
            ) : (
              <>
                <h2>
                  {room.status === "waiting"
                    ? "Your host will be right with you."
                    : room.guest
                      ? "The room is yours."
                      : "Save a seat for someone."}
                </h2>
                <p>
                  {room.status === "waiting"
                    ? "Your camera preview is only visible to you until your host approves."
                    : room.guest
                      ? "Two people. One conversation. Nothing to record or catch up on."
                      : "Your invitation works once and expires after 10 minutes. You decide who comes in."}
                </p>
                {room.role === "host" && !room.guest && !room.pending && (
                  <div className="invite-box">
                    <label htmlFor="invite">Private invitation link</label>
                    <div className="invite-input">
                      <Link size={16} />
                      <input
                        id="invite"
                        readOnly
                        value={invite}
                        placeholder="Create a new invitation"
                      />
                    </div>
                    <div className="invite-actions">
                      <button
                        className="primary-button"
                        disabled={!invite}
                        onClick={() =>
                          void run(async () => {
                            await navigator.clipboard.writeText(invite);
                            setNotice(
                              "Invitation copied. Share it with your guest.",
                            );
                          })
                        }
                      >
                        <Copy size={16} /> Copy invitation
                      </button>
                      <button
                        className="icon-button"
                        aria-label="Create new invitation"
                        disabled={busy}
                        onClick={() => void action("invite")}
                      >
                        <RefreshCw size={18} />
                      </button>
                    </div>
                  </div>
                )}
                {room.pending && room.role === "host" && (
                  <div className="approval">
                    <span className="avatar">{room.pending[0]}</span>
                    <h3>{room.pending} is at the door</h3>
                    <p>Only accept someone you expected.</p>
                    <div>
                      <button
                        className="primary-button"
                        disabled={busy}
                        onClick={() => void action("approve")}
                      >
                        <Check size={16} /> Accept
                      </button>
                      <button
                        className="secondary-button"
                        disabled={busy}
                        onClick={() => void action("reject")}
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                )}
                <div className="participants">
                  <span className="eyebrow">IN THIS ROOM</span>
                  <p>
                    <span className="avatar">{room.host[0]}</span>
                    <strong>{room.host}</strong>
                    <span>Host</span>
                  </p>
                  {room.guest && (
                    <p>
                      <span className="avatar guest-avatar">
                        {room.guest[0]}
                      </span>
                      <strong>{room.guest}</strong>
                      <span>Guest</span>
                    </p>
                  )}
                </div>
                {room.status === "admitted" && (
                  <button
                    className="text-button"
                    disabled={!stream}
                    onClick={() => setAttempt(attempt + 1)}
                  >
                    <RefreshCw size={15} /> Reconnect call
                  </button>
                )}
              </>
            )}
            <div className="panel-footer">
              <Headphones size={18} />
              <p>
                A quieter corner of the internet.
                <br />
                <strong>Built for being here.</strong>
              </p>
            </div>
          </aside>
        </div>
        <section className="assurances" aria-label="Privacy details">
          <article>
            <span className="assurance-icon">
              <LockKeyhole size={21} />
            </span>
            <div>
              <h3>Encrypted in transit</h3>
              <p>
                Browser-to-browser media encryption,
                <br className="desktop-break" /> even when a relay is needed.
              </p>
            </div>
          </article>
          <article>
            <span className="assurance-icon">
              <ShieldCheck size={21} />
            </span>
            <div>
              <h3>Your door. Your decision.</h3>
              <p>
                A one-time invitation and host approval.
                <br className="desktop-break" /> No unexpected plus-ones.
              </p>
            </div>
          </article>
          <article>
            <span className="assurance-icon">
              <Video size={21} />
            </span>
            <div>
              <h3>Here for the moment</h3>
              <p>
                No recording feature. No call history.
                <br className="desktop-break" /> Just a little face-to-face
                time.
              </p>
            </div>
          </article>
        </section>
      </main>
      <footer className="site-footer">
        <span>QuietLink · A room for two.</span>
        <details>
          <summary>Privacy & connection notes</summary>
          <p>
            QuietLink trusts its web origin, signaling service, and configured
            identity provider. Identity login does not independently verify
            media fingerprints. Guests can still record using other tools. Your
            peer may learn your IP address. Restricted networks may require a
            configured TURN relay. Rooms expire after two hours.
          </p>
          {account?.development && (
            <p>
              Development mode: the local identity provider offers test
              identities and does not authenticate real accounts.
            </p>
          )}
        </details>
        <span>Make room for a real conversation.</span>
      </footer>
    </div>
  );
}
