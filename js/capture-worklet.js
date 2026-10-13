// Forwards microphone samples (mono) to the analysis worker in blocks.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.out = null;
    this.buf = new Float32Array(1024);
    this.fill = 0;
    this.port.onmessage = (e) => { if (e.data.port) this.out = e.data.port; };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && this.out) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.fill++] = ch[i];
        if (this.fill === this.buf.length) {
          this.out.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(1024);
          this.fill = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
