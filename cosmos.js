// Cached nebula light and a bounded 3D dust field, shared by both screens.
class CosmicSpace {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.nebula = document.createElement('canvas');
    this.nebula.width = 960;
    this.nebula.height = 640;
    this.time = 0;
    this.paintNebula();
    this.resize();
  }

  random(seed) {
    const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return value - Math.floor(value);
  }

  paintNebula() {
    const ctx = this.nebula.getContext('2d');
    ctx.globalCompositeOperation = 'screen';
    // Overlapping, irregular clouds create a continuous band with dark dust lanes.
    for (let i = 0; i < 100; i++) {
      const along = this.random(i + 10);
      const spread = this.random(i + 210) - .5;
      const x = 960 * (.04 + along * .92);
      const y = 640 * (.86 - along * .72 + spread * .26);
      const radius = 35 + this.random(i + 410) * 120;
      const color = i % 3 === 0 ? '108,81,143' : '57,103,151';
      const cloud = ctx.createRadialGradient(x, y, 0, x, y, radius);
      cloud.addColorStop(0, `rgba(${color},0.075)`);
      cloud.addColorStop(.4, `rgba(${color},0.03)`);
      cloud.addColorStop(1, `rgba(${color},0)`);
      ctx.fillStyle = cloud;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 32; i++) {
      const along = i / 31;
      const x = 960 * along;
      const y = 640 * (.89 - along * .73 + Math.sin(along * 12) * .04);
      const radius = 25 + this.random(i + 600) * 44;
      const lane = ctx.createRadialGradient(x, y, 0, x, y, radius);
      lane.addColorStop(0, '#000000b0');
      lane.addColorStop(1, '#00000000');
      ctx.fillStyle = lane;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  resize() {
    this.width = innerWidth;
    this.height = innerHeight;
    const ratio = Math.min(devicePixelRatio || 1, 1.5);
    this.canvas.width = Math.round(this.width * ratio);
    this.canvas.height = Math.round(this.height * ratio);
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const count = this.width < 600 ? 280 : 850;
    this.dust = Array.from({ length: count }, (_, index) => {
      const along = this.random(index + 800);
      const clustered = index % 3 !== 0;
      const near = index % 30 === 0;
      return {
        x: (along - .5) * (near ? .55 : 1.65),
        y: (clustered
          ? .42 - along * .84 + (this.random(index + 1800) - .5) * .3
          : (this.random(index + 2800) - .5) * 1.5) * (near ? .42 : 1),
        near,
        trail: index % 90 === 0,
        z: near
          ? 360 + this.random(index + 3800) * 190
          : -650 + this.random(index + 3800) * 900,
        speed: near ? 45.5 : (5 + this.random(index + 4500) * 4) * 2.6,
        size: .45 + this.random(index + 4800) * 1.1,
        phase: this.random(index + 5800) * Math.PI * 2,
        color: ['#94aad2', '#a797c1', '#c0b39e'][index % 3],
        ox: 0,
        oy: 0,
        vx: 0,
        vy: 0,
      };
    });
  }

  draw(dt, pointer, landing, reduced, view) {
    if (!reduced) this.time += dt;
    const ctx = this.context;
    const w = this.width;
    const h = this.height;
    const motion = reduced ? 0 : 1;
    const t = this.time;
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = landing ? 1 : .8;
    ctx.drawImage(
      this.nebula,
      -w * .06 - pointer.x * 8 * motion,
      -h * .06 + pointer.y * 8 * motion,
      w * 1.12,
      h * 1.12
    );
    const mouseX = (pointer.x + 1) * w / 2;
    const mouseY = (1 - pointer.y) * h / 2;
    const orbitX = view ? Math.sin(view.rotationY) * (landing ? 0 : 12) : 0;
    const orbitY = view ? Math.sin(view.rotationX) * (landing ? 0 : 8) : 0;
    for (const dust of this.dust) {
      const speedBonus = landing ? 1 + Math.min(1, pointer.speed) * .12 : 1;
      const travel = dt * dust.speed * (landing ? 1 : .4) * speedBonus * motion;
      dust.z += travel;
      if (dust.z > 590) dust.z = dust.near ? 260 : -700;
      const z = dust.z;
      const perspective = (800 / (800 - z)) ** (landing ? 1.12 : 1);
      const x = w / 2 + dust.x * w * perspective
        + Math.sin(t * .035 + dust.phase) * 8 * motion
        - (pointer.x * 8 + orbitX) * perspective * motion;
      const y = h / 2 + dust.y * h * perspective
        + Math.cos(t * .03 + dust.phase) * 6 * motion
        + (pointer.y * 8 + orbitY) * perspective * motion;
      const dx = x - mouseX;
      const dy = y - mouseY;
      const distance = Math.hypot(dx, dy);
      const falloff = Math.max(0, 1 - distance / 130);
      const force = pointer.lastX === null
        ? 0
        : falloff * falloff * (9 + pointer.speed * 18) * motion;
      dust.vx += ((dx / Math.max(distance, 1) * force - dust.ox) * 30 - dust.vx * 10) * dt;
      dust.vy += ((dy / Math.max(distance, 1) * force - dust.oy) * 30 - dust.vy * 10) * dt;
      dust.ox += dust.vx * dt;
      dust.oy += dust.vy * dt;
      const quiet = landing && Math.hypot((x - w / 2) / (w * .29), (y - h * .48) / (h * .2)) < 1;
      const brightness = Math.min(.72, .16 + perspective * .2);
      const depthFade = Math.max(0, Math.min(1, (590 - z) / 70,
        dust.near ? (z - 260) / 70 : 1));
      ctx.globalAlpha = brightness * depthFade * (quiet ? .18 : 1) * (landing ? 1 : .65);
      ctx.fillStyle = dust.color;
      const size = Math.min(2.8, dust.size * perspective);
      if (landing && !reduced && dust.trail && z > 320) {
        const radialX = x - w / 2;
        const radialY = y - h / 2;
        const radius = Math.max(1, Math.hypot(radialX, radialY));
        const length = Math.min(10, 2 + (perspective - 1) * 1.4 + dust.speed * .035);
        const alpha = ctx.globalAlpha;
        ctx.globalAlpha = alpha * .55;
        ctx.strokeStyle = dust.color;
        ctx.lineWidth = Math.max(.5, size * .4);
        ctx.beginPath();
        ctx.moveTo(x + dust.ox, y + dust.oy);
        ctx.lineTo(x + dust.ox - radialX / radius * length,
          y + dust.oy - radialY / radius * length);
        ctx.stroke();
        ctx.globalAlpha = alpha;
      }
      ctx.fillRect(x + dust.ox, y + dust.oy, size, size);
    }
    ctx.globalAlpha = 1;
  }
}
