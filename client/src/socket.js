import { io } from 'socket.io-client';
import { getApiBase } from './apiBase.js';   // SPA-ANDROID-001

// undefined = same origin (the web builds); the Android app points at the
// shop chosen during setup.
const API_BASE = getApiBase() || undefined;

export const socket = io(API_BASE, {
  transports: ['websocket', 'polling'],
  autoConnect: true,
});
