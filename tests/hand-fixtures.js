// Anatomically structured synthetic landmarks for deterministic gesture tests.
// These are test inputs, not evidence of real-camera recognition accuracy.
function handFixture(x = .5, y = .5, pose = 'open') {
  const points = Array.from({ length: 21 }, () => ({ x, y, z: 0 }));
  const set = (i, dx, dy) => { points[i] = { x: x + dx, y: y + dy, z: 0 }; };
  set(0, 0, .14);
  set(1, -.065, .10); set(2, -.10, .04); set(3, -.14, -.01); set(4, -.18, -.04);
  const bases = [[5,-.065,0,.20],[9,-.02,-.02,.22],[13,.03,-.01,.20],[17,.075,.015,.16]];
  bases.forEach(([base, dx, dy, length], finger) => {
    set(base, dx, dy);
    if (pose === 'fist' || (pose === 'point' && finger > 0)) {
      set(base+1, dx, dy-.05); set(base+2, dx+.02, dy+.005); set(base+3, dx+.01, dy+.035);
    } else {
      set(base+1, dx, dy-length*.44); set(base+2, dx, dy-length*.75); set(base+3, dx, dy-length);
    }
  });
  if (pose === 'pinch') { set(8,-.11,-.12); set(4,-.108,-.119); }
  if (pose === 'fist') set(4,-.08,.04);
  return points;
}
if (typeof module !== 'undefined') module.exports = { handFixture };
