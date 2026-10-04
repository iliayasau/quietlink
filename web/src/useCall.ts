import { useEffect, useState } from 'react';
import type { Room } from './api';
type Signal = { type: 'reset' | 'ready' | 'offer' | 'answer' | 'candidate'; sdp?: string; candidate?: RTCIceCandidateInit };

export function useCall(room: Room | null, stream: MediaStream | null, ice: RTCIceServer[], attempt: number) {
  const [remote, setRemote] = useState<MediaStream | null>(null);
  const [state, setState] = useState('Preview only');
  useEffect(() => {
    if (!room || room.status !== 'admitted' || !stream) { setState(room?.status === 'waiting' ? 'Waiting for approval' : 'Preview only'); setRemote(null); return; }
    let stopped = false, retries = 0, ws: WebSocket, pc: RTCPeerConnection | null = null;
    let retry: ReturnType<typeof setTimeout>, timeout: ReturnType<typeof setTimeout>;
    let candidates: RTCIceCandidateInit[] = [];
    let chain = Promise.resolve();
    const reset = () => { clearTimeout(timeout); if (pc) { pc.onconnectionstatechange = null; pc.close(); } pc = null; candidates = []; setRemote(null); };
    const send = (message: Signal) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
    const create = () => {
      reset();
      const current = new RTCPeerConnection({ iceServers: ice }); pc = current;
      stream.getTracks().forEach(track => current.addTrack(track, stream));
      current.onicecandidate = event => { if (event.candidate && pc === current) send({ type: 'candidate', candidate: event.candidate.toJSON() }); };
      current.ontrack = event => { if (pc === current) setRemote(event.streams[0] ?? new MediaStream([event.track])); };
      current.onconnectionstatechange = () => {
        if (pc !== current || stopped) return;
        if (current.connectionState === 'connected') { clearTimeout(timeout); retries = 0; setState('Connected'); }
        if (current.connectionState === 'connecting') setState('Connecting securely');
        if (current.connectionState === 'disconnected') { setState('Connection interrupted'); clearTimeout(timeout); timeout = setTimeout(() => ws.close(), 8000); }
        if (current.connectionState === 'failed') { setState('Connection failed. Retry or check your network.'); }
      };
      timeout = setTimeout(() => { if (current.connectionState !== 'connected') setState('Still connecting. This network may require a TURN server.'); }, 20000);
      return current;
    };
    const receive = async (message: Signal) => {
      if (stopped) return;
      if (message.type === 'reset') {
        reset(); setState('Waiting for the other person');
        if (room.role === 'guest') { create(); send({ type: 'ready' }); }
      } else if (message.type === 'ready' && room.role === 'host') {
        const current = create(); const offer = await current.createOffer();
        if (pc !== current) return;
        await current.setLocalDescription(offer); send({ type: 'offer', sdp: offer.sdp });
      } else if (message.type === 'offer' && room.role === 'guest') {
        const current = pc ?? create(); await current.setRemoteDescription({ type: 'offer', sdp: message.sdp });
        for (const candidate of candidates) await current.addIceCandidate(candidate); candidates = [];
        const answer = await current.createAnswer(); await current.setLocalDescription(answer); send({ type: 'answer', sdp: answer.sdp });
      } else if (message.type === 'answer' && room.role === 'host' && pc) {
        await pc.setRemoteDescription({ type: 'answer', sdp: message.sdp });
        for (const candidate of candidates) await pc.addIceCandidate(candidate); candidates = [];
      } else if (message.type === 'candidate' && message.candidate) {
        if (pc?.remoteDescription) await pc.addIceCandidate(message.candidate);
        else if (candidates.length < 128) candidates.push(message.candidate);
      }
    };
    const connect = () => {
      if (stopped) return;
      setState(retries ? 'Reconnecting' : 'Opening the room');
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/rooms/${room.id}/signal`);
      ws.onmessage = event => { chain = chain.then(() => receive(JSON.parse(event.data) as Signal)).catch(() => { if (!stopped) setState('Could not connect. Please retry.'); }); };
      ws.onclose = event => {
        reset(); if (stopped) return;
        if (event.code === 1008 || ++retries > 5) { setState('Connection ended. Retry to reconnect.'); return; }
        setState('Reconnecting'); retry = setTimeout(connect, Math.min(1000 * 2 ** (retries - 1), 10000));
      };
    };
    connect();
    return () => { stopped = true; clearTimeout(retry); clearTimeout(timeout); ws.onclose = null; ws.close(); reset(); };
  }, [room?.id, room?.role, room?.status, stream, ice, attempt]);
  return { remote, state };
}
