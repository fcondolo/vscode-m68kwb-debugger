import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';

export interface Registers {
  d: number[];
  a: number[];
  pc: number;
  sr: number;
}

export class EmulatorServer extends EventEmitter {
  private wss?: WebSocketServer;
  private ws?: WebSocket;

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
    this.ws?.close();
    this.ws = undefined;
    this.wss?.close();
    this.wss = undefined;
    this.removeAllListeners();
  }

  private send(obj: any) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('EmulatorServer.send: no emulator connected, dropping', obj.cmd);
      return;
    }
    this.ws.send(JSON.stringify(obj));
  }
}