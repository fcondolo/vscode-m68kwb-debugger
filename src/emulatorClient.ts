import WebSocket from 'ws';
import { EventEmitter } from 'events';

export interface Registers {
  d: number[];   // D0..D7
  a: number[];   // A0..A7
  pc: number;
  sr: number;
}

export class EmulatorClient extends EventEmitter {
  private ws!: WebSocket;

  async connect(url: string): Promise<void> {
    this.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      // re-emit as a typed event the DebugSession can listen to
      this.emit(msg.event, msg);
    });
  }

  load(program: string)            { this.send({ cmd: 'load', program }); }
  setBreakpoints(file: string, lines: number[]) {
    this.send({ cmd: 'setBreakpoints', file, lines });
  }
  cont()     { this.send({ cmd: 'continue' }); }
  stepOver() { this.send({ cmd: 'stepOver' }); }
  stepIn()   { this.send({ cmd: 'stepIn' }); }
  pause()    { this.send({ cmd: 'pause' }); }

  private send(obj: any) {
    this.ws.send(JSON.stringify(obj));
  }

disconnect(): void {
  if (this.ws && this.ws.readyState === this.ws.OPEN) {
    this.ws.close();
  }
  this.removeAllListeners();
}  
}