/* A single GPU point field. No network dependency or per-pixel DOM nodes. */
class PixelRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl', {
      alpha: true,
      antialias: false,
      premultipliedAlpha: false,
      powerPreference: 'low-power'
    });
    if (!this.gl) {
      throw new Error('WebGL is unavailable');
    }

    const gl = this.gl;
    const vertex = this.compile(gl.VERTEX_SHADER, `
      attribute vec3 aPosition;
      attribute vec3 aColor;
      uniform vec2 uRotation;
      uniform float uRoll;
      uniform vec2 uSpan;
      uniform float uZoom;
      uniform float uSize;
      uniform float uOffset;
      uniform float uOffsetX;
      varying vec3 vColor;

      void main() {
        float sx = sin(uRotation.x);
        float cx = cos(uRotation.x);
        float sy = sin(uRotation.y);
        float cy = cos(uRotation.y);
        vec3 p = vec3(
          aPosition.x,
          aPosition.y * cx - aPosition.z * sx,
          aPosition.y * sx + aPosition.z * cx
        );
        p = vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);
        p.xy = mat2(cos(uRoll), sin(uRoll), -sin(uRoll), cos(uRoll)) * p.xy;
        float perspective = 12.0 / max(4.0, 12.0 - p.z);
        vec2 projected = p.xy * perspective * uZoom / uSpan;
        gl_Position = vec4(projected.x + uOffsetX, projected.y + uOffset, -p.z / 20.0, 1.0);
        gl_PointSize = max(1.0, uSize * perspective * uZoom);
        vColor = aColor * clamp(1.0 + p.z * 0.11, 0.65, 1.23);
      }
    `);
    const fragment = this.compile(gl.FRAGMENT_SHADER, `
      precision mediump float;
      uniform float uOpacity;
      varying vec3 vColor;

      void main() {
        gl_FragColor = vec4(vColor, uOpacity);
      }
    `);
    this.program = gl.createProgram();
    gl.attachShader(this.program, vertex);
    gl.attachShader(this.program, fragment);
    gl.linkProgram(this.program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(this.program));
    }

    gl.useProgram(this.program);
    this.position = gl.createBuffer();
    this.color = gl.createBuffer();
    this.attributes = {
      position: gl.getAttribLocation(this.program, 'aPosition'),
      color: gl.getAttribLocation(this.program, 'aColor')
    };
    this.uniforms = {};
    for (const name of ['Rotation', 'Roll', 'Span', 'Zoom', 'Size', 'Offset', 'OffsetX', 'Opacity']) {
      this.uniforms[name] = gl.getUniformLocation(this.program, `u${name}`);
    }

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.count = 0;
  }

  compile(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(message);
    }

    return shader;
  }

  setField(positions, colors) {
    const gl = this.gl;
    this.count = positions.length / 3;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.position);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.color);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);
  }

  resize(width, height) {
    this.ratio = Math.min(devicePixelRatio || 1, innerWidth < 600 ? 1.5 : 2);
    this.canvas.width = Math.round(width * this.ratio);
    this.canvas.height = Math.round(height * this.ratio);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  draw(positions, view) {
    const gl = this.gl;
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.position);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions);
    gl.enableVertexAttribArray(this.attributes.position);
    gl.vertexAttribPointer(this.attributes.position, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.color);
    gl.enableVertexAttribArray(this.attributes.color);
    gl.vertexAttribPointer(this.attributes.color, 3, gl.FLOAT, false, 0, 0);
    gl.uniform2f(this.uniforms.Rotation, view.rotationX, view.rotationY);
    gl.uniform1f(this.uniforms.Roll, view.rotationZ || 0);
    gl.uniform2f(this.uniforms.Span, view.width / 2, view.height / 2);
    gl.uniform1f(this.uniforms.Zoom, view.zoom);
    gl.uniform1f(this.uniforms.Size, view.size * this.ratio);
    gl.uniform1f(this.uniforms.Offset, view.offset);
    gl.uniform1f(this.uniforms.OffsetX, view.offsetX || 0);
    gl.uniform1f(this.uniforms.Opacity, view.opacity);
    gl.drawArrays(gl.POINTS, 0, this.count);
  }

  clearField() {
    this.count = 0;
    const gl = this.gl;
    for (const buffer of [this.position, this.color]) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, 0, gl.STATIC_DRAW);
    }
  }

  dispose() {
    const gl = this.gl;
    gl.deleteBuffer(this.position);
    gl.deleteBuffer(this.color);
    gl.deleteProgram(this.program);
  }
}
