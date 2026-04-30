import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';

export interface Registers {
  d: number[];
  a: number[];
  pc: number;
  sr: number;
  x: number;
  n: number;
  z: number;
  v: number;
  c: number;
}

export class EmulatorServer extends EventEmitter {
  private wss?: WebSocketServer;
  private ws?: WebSocket;
  private pendingMessages: any[] = [];

  /** Start listening. Resolves when the server is bound to the port. */
  listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port });
      this.wss.once('listening', () => resolve());
      this.wss.once('error', reject);

      this.wss.on('connection', (ws) => {
        // Only one emulator at a time. If a second connects, drop the old one.
        if (this.ws) { this.ws.close(); }
        this.ws = ws;

        // Flush messages queued while disconnected
        for (const obj of this.pendingMessages) {
          console.error(`[server] FLUSH ${obj.cmd}`);
          this.ws.send(JSON.stringify(obj));
        }
        this.pendingMessages = [];

        this.emit('connected');

      ws.on('message', (data) => {
        const text = data.toString();
        console.error('[server] received:', text);
        try {
          const msg = JSON.parse(text);
          console.error('[server] parsed event:', msg.event);
          this.emit(msg.event, msg);
        } catch (err) {
          console.error('[server] parse failed:', err);
        }
      });


        ws.on('close', () => {
          if (this.ws === ws) { this.ws = undefined; }
          this.pendingMessages = [];   // don't replay across reconnects
          this.emit('emulator-disconnected');
        });
      });
    });
  }

  /** Wait until an emulator connects, or reject after `timeoutMs`. */
  waitForEmulator(timeoutMs: number): Promise<void> {
    if (this.ws) { return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('connected', onConnect);
        reject(new Error(`No emulator connected within ${timeoutMs}ms`));
      }, timeoutMs);
      const onConnect = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once('connected', onConnect);
    });
  }

  load(program: string)               { this.send({ cmd: 'load', program }); }
  setBreakpoints(file: string, lines: number[]) {
    this.send({ cmd: 'setBreakpoints', file, lines });
  }
  cont()     { this.send({ cmd: 'continue' }); }
  stepOver() { this.send({ cmd: 'stepOver' }); }
  stepIn()   { this.send({ cmd: 'stepIn' }); }
  pause()    { this.send({ cmd: 'pause' }); }

  disconnect(): void {
  // Tell the emulator to stop before we tear down the socket.
  if (this.ws && this.ws.readyState === this.ws.OPEN) {
    try {
      this.ws.send(JSON.stringify({ cmd: 'stop' }));
    } catch (_) { /* ignore */ }
  }
  this.ws?.close();
  this.ws = undefined;
  this.wss?.close();
  this.wss = undefined;
  this.pendingMessages = [];
  this.removeAllListeners();
}


  private send(obj: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      console.error(`[server] SEND ${obj.cmd}`);
      this.ws.send(JSON.stringify(obj));
    } else {
      console.error(`[server] BUFFER ${obj.cmd}`);
      this.pendingMessages.push(obj);
    }
  }
}