import { useEffect, useState } from "react";
import type { Room } from "./api";
type Signal = {
  epoch?: number;
  type: "reset" | "ready" | "offer" | "answer" | "candidate";
  sdp?: string;
  candidate?: RTCIceCandidateInit;
};
type NegotiationQueue = { messages: Signal[]; processing: boolean };

export function useCall(
  room: Room | null,
  stream: MediaStream | null,
  ice: RTCIceServer[],
  attempt: number,
) {
  const [remote, setRemote] = useState<MediaStream | null>(null);
  const [state, setState] = useState("Preview only");
  useEffect(() => {
    if (!room || room.status !== "admitted" || !stream) {
      setState(
        room?.status === "waiting" ? "Waiting for approval" : "Preview only",
      );
      setRemote(null);
      return;
    }
    let stopped = false,
      retries = 0,
      ws: WebSocket,
      pc: RTCPeerConnection | null = null;
    let retry: ReturnType<typeof setTimeout>,
      timeout: ReturnType<typeof setTimeout>;
    let candidates: RTCIceCandidateInit[] = [];
    let epoch = 0;
    let socketGeneration = 0;
    let discardSocketWork = () => {};
    const reset = () => {
      clearTimeout(timeout);
      if (pc) {
        pc.onconnectionstatechange = null;
        pc.close();
      }
      pc = null;
      candidates = [];
      setRemote(null);
    };
    const send = (message: Signal) => {
      if (!stopped && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ ...message, epoch }));
    };
    const create = () => {
      reset();
      const current = new RTCPeerConnection({ iceServers: ice });
      pc = current;
      stream.getTracks().forEach((track) => current.addTrack(track, stream));
      current.onicecandidate = (event) => {
        if (event.candidate && pc === current)
          send({ type: "candidate", candidate: event.candidate.toJSON() });
      };
      current.ontrack = (event) => {
        if (pc === current)
          setRemote(event.streams[0] ?? new MediaStream([event.track]));
      };
      current.onconnectionstatechange = () => {
        if (pc !== current || stopped) return;
        if (current.connectionState === "connected") {
          clearTimeout(timeout);
          retries = 0;
          setState("Connected");
        }
        if (current.connectionState === "connecting")
          setState("Connecting securely");
        if (current.connectionState === "disconnected") {
          setState("Connection interrupted");
          clearTimeout(timeout);
          timeout = setTimeout(() => ws.close(), 8000);
        }
        if (current.connectionState === "failed") {
          setState("Connection failed. Retry or check your network.");
        }
      };
      timeout = setTimeout(() => {
        if (current.connectionState !== "connected")
          setState("Still connecting. This network may require a TURN server.");
      }, 20000);
      return current;
    };
    const receive = async (message: Signal, valid: () => boolean) => {
      if (!valid()) return;
      if (message.type === "ready" && room.role === "host" && !pc) {
        const current = (pc = create());
        const offer = await current.createOffer();
        if (!valid() || pc !== current) return;
        await current.setLocalDescription(offer);
        if (!valid() || pc !== current) return;
        send({ type: "offer", sdp: offer.sdp });
      } else if (message.type === "offer" && room.role === "guest") {
        const current = pc ?? create();
        await current.setRemoteDescription({ type: "offer", sdp: message.sdp });
        if (!valid() || pc !== current) return;
        for (const candidate of candidates) {
          await current.addIceCandidate(candidate);
          if (!valid() || pc !== current) return;
        }
        candidates = [];
        const answer = await current.createAnswer();
        if (!valid() || pc !== current) return;
        await current.setLocalDescription(answer);
        if (!valid() || pc !== current) return;
        send({ type: "answer", sdp: answer.sdp });
      } else if (message.type === "answer" && room.role === "host" && pc) {
        const current = pc;
        await current.setRemoteDescription({
          type: "answer",
          sdp: message.sdp,
        });
        if (!valid() || pc !== current) return;
        for (const candidate of candidates) {
          await current.addIceCandidate(candidate);
          if (!valid() || pc !== current) return;
        }
        candidates = [];
      } else if (message.type === "candidate" && message.candidate) {
        if (pc?.remoteDescription) await pc.addIceCandidate(message.candidate);
        else if (candidates.length < 128) candidates.push(message.candidate);
      }
    };
    const connect = () => {
      if (stopped) return;
      const generation = ++socketGeneration;
      epoch = 0;
      let queue: NegotiationQueue = { messages: [], processing: false };
      const discardQueue = () => {
        queue.messages.length = 0;
        // Closing a peer need not settle its outstanding browser promises.
        // Each epoch owns its drain, including the processing flag in finally.
        queue = { messages: [], processing: false };
      };
      setState(retries ? "Reconnecting" : "Opening the room");
      const socket = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/rooms/${room.id}/signal`,
      );
      ws = socket;
      const active = () =>
        !stopped &&
        socketGeneration === generation &&
        socket.readyState === WebSocket.OPEN;
      const drain = async (current: NegotiationQueue) => {
        if (current.processing) return;
        current.processing = true;
        try {
          while (active() && queue === current && current.messages.length) {
            const message = current.messages.shift()!;
            const valid = () =>
              active() && queue === current && message.epoch === epoch;
            try {
              await receive(message, valid);
            } catch {
              if (valid()) setState("Could not connect. Please retry.");
            }
          }
        } finally {
          current.processing = false;
        }
      };
      const invalidate = () => {
        socketGeneration++;
        discardQueue();
        reset();
      };
      discardSocketWork = invalidate;
      socket.onmessage = (event) => {
        if (!active()) return;
        let message: Signal;
        try {
          if (typeof event.data !== "string" || event.data.length > 65536)
            throw new Error("invalid message");
          message = JSON.parse(event.data) as Signal;
          if (!message || !Number.isSafeInteger(message.epoch))
            throw new Error("invalid epoch");
        } catch {
          invalidate();
          socket.close(1000, "Invalid signaling message");
          setState("Connection ended. Retry to reconnect.");
          return;
        }
        // Reset is a cancellation boundary, not an item behind negotiation work.
        if (message.type === "reset") {
          if (!message.epoch || message.epoch <= epoch) return;
          epoch = message.epoch;
          discardQueue();
          reset();
          setState("Waiting for the other person");
          if (room.role === "guest") {
            create();
            send({ type: "ready" });
          }
          return;
        }
        if (message.epoch !== epoch) return;
        if (queue.messages.length >= 32) {
          invalidate();
          socket.close(1000, "Signaling queue full");
          setState("Connection ended. Retry to reconnect.");
          return;
        }
        queue.messages.push(message);
        void drain(queue);
      };
      socket.onclose = (event) => {
        if (stopped || socketGeneration !== generation) return;
        invalidate();
        if (event.code === 1008 || ++retries > 5) {
          setState("Connection ended. Retry to reconnect.");
          return;
        }
        setState("Reconnecting");
        retry = setTimeout(connect, Math.min(1000 * 2 ** (retries - 1), 10000));
      };
    };
    connect();
    return () => {
      stopped = true;
      discardSocketWork();
      clearTimeout(retry);
      clearTimeout(timeout);
      ws.onclose = null;
      ws.close();
    };
  }, [room?.id, room?.role, room?.status, stream, ice, attempt]);
  return { remote, state };
}
