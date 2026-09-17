// Ses algılama worklet'i: mikrofonun ses düzeyini (RMS) hesaplar ve ~40 ms'de
// bir ana iş parçacığına bildirir. Ses işleme iş parçacığında çalıştığı için
// sekme arka plandayken (alt+tab) zamanlayıcı kısıtlamalarından etkilenmez.
class VadProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.acc = 0;
    this.count = 0;
    this.blocks = 0;
    // 128 örnekli bloklar: ~40 ms'lik pencere için kaç blok gerektiği.
    this.tick = Math.max(1, Math.round((sampleRate * 0.04) / 128));
  }

  process(inputs) {
    const kanal = inputs[0] && inputs[0][0];
    if (kanal) {
      let toplam = 0;
      for (let i = 0; i < kanal.length; i += 1) toplam += kanal[i] * kanal[i];
      this.acc += toplam / kanal.length;
      this.count += 1;
    }
    this.blocks += 1;
    if (this.blocks >= this.tick) {
      const rms = this.count ? Math.sqrt(this.acc / this.count) : 0;
      this.port.postMessage(rms);
      this.acc = 0;
      this.count = 0;
      this.blocks = 0;
    }
    return true;
  }
}

registerProcessor('vad', VadProcessor);
