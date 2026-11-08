// Image-derived light and fragments use the same camera projection as the sculpture.
class ImageAtmosphere {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.halo = document.createElement('canvas');
    this.halo.width = 640;
    this.halo.height = 480;
    this.fragments = [];
    this.time = 0;
    this.resize();
  }

  random(seed) {
    const value = Math.sin(seed * 91.7 + 17.3) * 43758.5453;
    return value - Math.floor(value);
  }

  resize() {
    this.width = innerWidth;
    this.height = innerHeight;
    const ratio = Math.min(devicePixelRatio || 1, 1.5);
    this.canvas.width = Math.round(this.width * ratio);
    this.canvas.height = Math.round(this.height * ratio);
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  setSource(source) {
    const sample = document.createElement('canvas');
    sample.width = 64;
    sample.height = 48;
    const ctx = sample.getContext('2d');
    ctx.drawImage(source, 0, 0, 64, 48);
    const data = ctx.getImageData(0, 0, 64, 48).data;
    this.fragments.length = 0;
    const halo = this.halo.getContext('2d');
    halo.clearRect(0, 0, 640, 480);
    // Overlapping elliptical clouds avoid any visible circular halo boundary.
    for (let zone = 0; zone < 6; zone++) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let weight = 0;
      const left = zone % 3 * 21;
      const top = Math.floor(zone / 3) * 24;
      for (let y = top; y < top + 24; y++) {
        for (let x = left; x < left + 21; x++) {
          const p = (y * 64 + x) * 4;
          const alpha = data[p + 3] / 255;
          red += data[p] * alpha;
          green += data[p + 1] * alpha;
          blue += data[p + 2] * alpha;
          weight += alpha;
        }
      }
      const color = `${red / Math.max(1, weight)},${green / Math.max(1, weight)},${blue / Math.max(1, weight)}`;
      halo.save();
      halo.translate(130 + zone % 3 * 190, 165 + Math.floor(zone / 3) * 145);
      halo.scale(1.7, .9);
      const cloud = halo.createRadialGradient(0, 0, 0, 0, 0, 150);
      cloud.addColorStop(0, `rgba(${color},.27)`);
      cloud.addColorStop(.45, `rgba(${color},.1)`);
      cloud.addColorStop(1, `rgba(${color},0)`);
      halo.fillStyle = cloud;
      halo.fillRect(-150, -150, 300, 300);
      halo.restore();
    }
    halo.globalCompositeOperation = 'destination-in';
    const horizontal = halo.createLinearGradient(0, 0, 640, 0);
    horizontal.addColorStop(0, '#ffffff00');
    horizontal.addColorStop(.22, '#ffffff');
    horizontal.addColorStop(.78, '#ffffff');
    horizontal.addColorStop(1, '#ffffff00');
    halo.fillStyle = horizontal;
    halo.fillRect(0, 0, 640, 480);
    const vertical = halo.createLinearGradient(0, 0, 0, 480);
    vertical.addColorStop(0, '#ffffff00');
    vertical.addColorStop(.22, '#ffffff');
    vertical.addColorStop(.78, '#ffffff');
    vertical.addColorStop(1, '#ffffff00');
    halo.fillStyle = vertical;
    halo.fillRect(0, 0, 640, 480);
    halo.globalCompositeOperation = 'source-over';
    for (let i = 0; i < 1500; i++) {
      const side = i % 4;
      let nx = this.random(i + 100) - .5;
      let ny = this.random(i + 2100) - .5;
      if (side < 2) nx = (side === 0 ? -1 : 1) * (.34 + this.random(i + 3100) * .16);
      else ny = (side === 2 ? -1 : 1) * (.34 + this.random(i + 4100) * .16);
      const x = Math.max(0, Math.min(63, Math.floor((nx + .5) * 64)));
      const y = Math.max(0, Math.min(47, Math.floor((ny + .5) * 48)));
      const p = (y * 64 + x) * 4;
      if (data[p + 3] < 40) continue;
      const scatter = .08 + this.random(i + 5100) ** 2 * .65;
      const light = (data[p] + data[p + 1] + data[p + 2]) / 765;
      this.fragments.push({
        x: nx * (1 + scatter * 2),
        y: -ny * (1 + scatter * 2),
        z: (this.random(i + 6100) - .4) * 2.7,
        phase: this.random(i + 7100) * Math.PI * 2,
        size: .55 + this.random(i + 8100) * 1.2,
        color: `rgb(${data[p]},${data[p + 1]},${data[p + 2]})`,
        alpha: .2 + light * .6,
      });
    }
  }

  draw(dt, view, fieldWidth, fieldHeight, viewer, reduced, pointer) {
    if (!reduced) this.time += dt;
    const t = this.time;
    const ctx = this.context;
    const w = this.width;
    const h = this.height;
    ctx.clearRect(0, 0, w, h);
    if (!this.fragments.length) return;
    const centerX = w * (1 + (view.offsetX || 0)) / 2;
    const centerY = h * (1 - view.offset) / 2;
    const imageW = fieldWidth / view.width * w * view.zoom;
    const imageH = fieldHeight / view.height * h * view.zoom;
    ctx.globalAlpha = viewer ? .75 : .3;
    if (viewer) {
      ctx.drawImage(this.halo, centerX - imageW * .85, centerY - imageH, imageW * 1.7, imageH * 2);
    } else {
      ctx.drawImage(this.halo, -w * .25, h * .25, w, h);
    }
    const cx = Math.cos(view.rotationX);
    const sx = Math.sin(view.rotationX);
    const cy = Math.cos(view.rotationY);
    const sy = Math.sin(view.rotationY);
    const stride = w < 600 ? 4 : w < 1000 ? 2 : 1;
    for (let i = 0; i < this.fragments.length; i += stride) {
      const fragment = this.fragments[i];
      const drift = reduced ? 0 : Math.sin(t * .19 + fragment.phase);
      let x;
      let y;
      let perspective;
      if (viewer) {
        const localX = fragment.x * fieldWidth + drift * .035;
        const localY = fragment.y * fieldHeight;
        const localZ = fragment.z + drift * .08;
        const rotatedY = localY * cx - localZ * sx;
        const rotatedZ = localY * sx + localZ * cx;
        const rotatedX = localX * cy + rotatedZ * sy;
        const z = -localX * sy + rotatedZ * cy;
        perspective = 12 / Math.max(4, 12 - z);
        const cz = Math.cos(view.rotationZ || 0), sz = Math.sin(view.rotationZ || 0);
        x = centerX + (rotatedX * cz - rotatedY * sz) * perspective * view.zoom / view.width * w;
        y = centerY - (rotatedX * sz + rotatedY * cz) * perspective * view.zoom / view.height * h;
      } else {
        perspective = 1 + fragment.z * .12;
        const along = this.random(i + 9000);
        x = w * (.04 + along * .92) + drift * 4 - pointer.x * perspective * 9;
        y = h * (.9 - along * .78 + fragment.y * .26) + drift * 3;
      }
      ctx.globalAlpha = fragment.alpha * (viewer ? .85 : .36);
      ctx.fillStyle = fragment.color;
      const size = Math.min(3, fragment.size * perspective);
      ctx.fillRect(x, y, size, size);
    }
    ctx.globalAlpha = 1;
  }

  clear() {
    this.fragments.length = 0;
    this.halo.getContext('2d').clearRect(0, 0, 640, 480);
    this.context.clearRect(0, 0, this.width, this.height);
  }
}
