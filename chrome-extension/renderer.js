// GPU motion estimation runs at the source cadence. The display pass only samples
// two colour textures and the previously computed motion field.
function kittyRenderer(canvas, onCaptureError, requireHardware = false) {
  const gl = canvas.getContext("webgl2", {
    alpha: false, antialias: false, depth: false, failIfMajorPerformanceCaveat: requireHardware,
  });
  if (!gl) throw new Error("WebGL 2 unavailable");
  const vertex = `#version 300 es
    out vec2 uv;
    void main() {
      vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
      uv = vec2(p.x, 1.0-p.y);
      gl_Position = vec4(p*2.0-1.0, 0.0, 1.0);
    }`;
  function programFor(fragment) {
    const program = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, "older"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "newer"), 1);
    return program;
  }
  // A tiny occlusion query distinguishes motion from codec noise. Poll it on
  // the next animation tick; never read a video frame back to the CPU.
  const compare = programFor(`#version 300 es
    precision highp float;
    uniform sampler2D older, newer;
    out vec4 color;
    void main() {
      float sum=0., peak=0.;
      for (int y=0; y<8; y++) for (int x=0; x<16; x++) {
        vec2 uv=(vec2(x,y)+.5)/vec2(16.,8.);
        vec3 delta=abs(textureLod(older,uv,3.).rgb-textureLod(newer,uv,3.).rgb);
        float d=dot(delta,vec3(.299,.587,.114));
        sum+=d; peak=max(peak,d);
      }
      if (sum/128.<.003 && peak<.045) discard;
      color=vec4(1.);
    }`);
  const estimate = programFor(kittyFlowShader);
  const gridSize = gl.getUniformLocation(estimate, "gridSize");
  const present = programFor(`#version 300 es
    precision highp float;
    in vec2 uv;
    uniform sampler2D older, newer, flow;
    uniform float weight;
    out vec4 color;
    void main() {
      vec2 size = vec2(textureSize(older,0));
      vec3 field = texture(flow,uv).rgb;
      vec2 motion = (field.rg * 255. - 128.) * .25 * max(1.,size.x/1920.) / size;
      vec4 a = textureLod(older, uv-weight*motion, 0.);
      vec4 b = textureLod(newer, uv+(1.-weight)*motion, 0.);
      vec4 old = textureLod(older,uv,0.), fresh = textureLod(newer,uv,0.);
      vec3 luma = vec3(.299,.587,.114);
      float residual = dot(abs(a.rgb-b.rgb),luma);
      float raw = dot(abs(old.rgb-fresh.rgb),luma);
      // Prefer agreement along the estimated trajectory; soften uncertain
      // boundaries, where foreground and background may move independently.
      float trust = max(.5*field.b,smoothstep(.005,.045,raw-residual))
                  * (1.-smoothstep(.07,.22,residual));
      vec4 stationary = mix(old,fresh,weight);
      color = mix(stationary,mix(a,b,weight),trust);
      vec3 delta = abs(old.rgb-fresh.rgb);
      float stable = 1.-smoothstep(.015,.060,max(delta.r,max(delta.g,delta.b)));
      if (stable > 0. && any(greaterThan(abs(color.rgb-stationary.rgb),vec3(.012)))) {
        const vec2 offsets[4] = vec2[4](vec2(1,0),vec2(-1,0),vec2(0,1),vec2(0,-1));
        float edge = 0.;
        for (int i=0; i<4; ++i) {
          vec2 pos = uv + offsets[i]/size;
          float ga = dot(old.rgb-textureLod(older,pos,0.).rgb,luma);
          float gb = dot(fresh.rgb-textureLod(newer,pos,0.).rgb,luma);
          float agreement = 1.-smoothstep(.08,.25,abs(ga-gb));
          edge = max(edge,agreement*min(abs(ga),sign(ga)*gb));
        }
        color = mix(color,stationary,stable*smoothstep(.05,.20,edge));
      }
    }`);
  const weight = gl.getUniformLocation(present, "weight");
  gl.uniform1i(gl.getUniformLocation(present, "flow"), 2);
  const fbo = gl.createFramebuffer();
  let width, height, cols, rows, probe, pending, serial = 0;
  let slots = [], frames = [];
  let captureGeneration = 0, capturing = false, bitmapUploadMs = 0;
  let useBitmap = !requireHardware && typeof createImageBitmap === "function";
  const timer = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  const uploadTiming = {calls: 0}, flowTiming = {calls: 0}, drawTiming = {calls: 0};
  const timings = [uploadTiming, flowTiming, drawTiming];
  function startTimer(stage) {
    stage.calls++;
    if (!timer || stage.query) return false;
    stage.query = gl.createQuery();
    if (!stage.query) return false;
    gl.beginQuery(timer.TIME_ELAPSED_EXT, stage.query);
    return true;
  }
  function gpuLoad(elapsed) {
    const disjoint = timer && gl.getParameter(timer.GPU_DISJOINT_EXT);
    for (const stage of timings) {
      if (disjoint) stage.ms = undefined;
      if (!stage.query) continue;
      if (!disjoint && !gl.getQueryParameter(stage.query, gl.QUERY_RESULT_AVAILABLE)) continue;
      if (!disjoint) {
        const ms = gl.getQueryParameter(stage.query, gl.QUERY_RESULT) / 1e6;
        stage.ms = stage.ms === undefined ? ms : .75 * stage.ms + .25 * ms;
      }
      gl.deleteQuery(stage.query);
      stage.query = undefined;
    }
    const known = timer && elapsed > 0 && timings.every(stage => !stage.calls || Number.isFinite(stage.ms));
    const busy = timings.reduce((sum, stage) => sum + stage.calls * (stage.ms || 0), 0);
    for (const stage of timings) stage.calls = 0;
    return known ? Math.min(100, 100 * busy / elapsed) : null;
  }
  function texture(w,h,levels,allocate = true) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,t);
    if (allocate) gl.texStorage2D(gl.TEXTURE_2D,levels,gl.RGBA8,w,h);
    else gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAX_LEVEL,levels-1);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,levels > 1 ? gl.LINEAR_MIPMAP_NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    return t;
  }
  function bind(i,t) { gl.activeTexture(gl.TEXTURE0+i); gl.bindTexture(gl.TEXTURE_2D,t); }
  function target(t,w,h) {
    gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,t,0);
    gl.viewport(0,0,w,h);
  }
  function reset() {
    captureGeneration++;
    bitmapUploadMs = 0;
    if (pending?.query) gl.deleteQuery(pending.query);
    pending = undefined;
    frames = [];
    for (const stage of timings) {
      if (stage.query) gl.deleteQuery(stage.query);
      stage.query = stage.ms = undefined;
      stage.calls = 0;
    }
  }
  function release() {
    reset();
    for (const slot of slots) {
      gl.deleteTexture(slot.image);
      gl.deleteTexture(slot.motion);
    }
    gl.deleteTexture(probe || null);
    slots = [];
  }
  function poll(force = false) {
    if (!pending) return;
    let changed = true;
    if (pending.query) {
      const ready = gl.getQueryParameter(pending.query,gl.QUERY_RESULT_AVAILABLE);
      if (!ready && !force) return;
      if (ready) changed = gl.getQueryParameter(pending.query,gl.QUERY_RESULT);
      gl.deleteQuery(pending.query);
    }
    const {slot,time} = pending;
    pending = undefined;
    if (!changed) return;
    const previous = frames.at(-1);
    if (previous) {
      const timed = startTimer(flowTiming);
      bind(0,previous.slot.image); bind(1,slot.image); bind(2,null);
      target(slot.motion,cols,rows);
      gl.useProgram(estimate);
      gl.uniform2f(gridSize,cols,rows);
      gl.drawArrays(gl.TRIANGLES,0,3);
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      if (timed) gl.endQuery(timer.TIME_ELAPSED_EXT);
    }
    frames.push({slot,time,id:++serial});
    if (frames.length > 4) frames.shift();
  }
  function uploadFrame(source, frameWidth, frameHeight, time) {
    if (width !== frameWidth || height !== frameHeight) {
      release();
      width = canvas.width = frameWidth;
      height = canvas.height = frameHeight;
      const block = Math.max(8,Math.round(12*width/1920));
      cols = Math.ceil(width/block);
      rows = Math.ceil(height/block);
      probe = texture(1,1,1);
    }
    poll(true);
    const timed = startTimer(uploadTiming);
    let slot = slots.find(s => frames.every(f => f.slot !== s));
    if (!slot) {
      const levels = Math.min(6,1+Math.floor(Math.log2(Math.max(width,height))));
      slot = {image:texture(width,height,levels,!requireHardware),motion:texture(cols,rows,1)};
      slots.push(slot);
    }
    bind(1,slot.image);
    // Chromium can copy a hardware-decoded video texture directly with texImage2D.
    if (requireHardware) gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,gl.RGBA,gl.UNSIGNED_BYTE,source);
    else gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,gl.RGBA,gl.UNSIGNED_BYTE,source);
    gl.generateMipmap(gl.TEXTURE_2D);
    const previous = frames.at(-1);
    let query;
    if (previous) {
      bind(0,previous.slot.image);
      target(probe,1,1);
      gl.useProgram(compare);
      query = gl.createQuery();
      gl.beginQuery(gl.ANY_SAMPLES_PASSED,query);
      gl.drawArrays(gl.TRIANGLES,0,3);
      gl.endQuery(gl.ANY_SAMPLES_PASSED);
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    }
    pending = {slot,time,query};
    if (timed) gl.endQuery(timer.TIME_ELAPSED_EXT);
  }
  let lastId, lastWeight;
  return {
    reset,
    resources(elapsed) {
      let pixels = 0;
      if (width && height) {
        const levels = Math.min(6, 1 + Math.floor(Math.log2(Math.max(width, height))));
        for (let i = 0; i < levels; i++) pixels += Math.max(1, width >> i) * Math.max(1, height >> i);
      }
      const browserMs = bitmapUploadMs;
      bitmapUploadMs = 0;
      return {gpu: gpuLoad(elapsed), browserMs, bytes: 4 * ((probe ? 1 : 0) + slots.length * (pixels + (cols || 0) * (rows || 0)))};
    },
    upload(video,time) {
      if (!useBitmap) {
        uploadFrame(video, video.videoWidth, video.videoHeight, time);
        return;
      }
      if (capturing) return;
      capturing = true;
      const generation = captureGeneration;
      // Chromium can reuse the video texture when the source is an ImageBitmap.
      createImageBitmap(video).then(bitmap => {
        try {
          if (generation !== captureGeneration) return;
          const began = performance.now();
          uploadFrame(bitmap, bitmap.width, bitmap.height, time);
          bitmapUploadMs += performance.now() - began;
        } finally {
          bitmap.close();
        }
      }, () => {
        if (generation === captureGeneration) useBitmap = false;
      }).catch(onCaptureError).finally(() => {
        capturing = false;
      });
    },
    drawAt(time) {
      poll();
      if (frames.length < 2) return false;
      let end = frames.findIndex((f,i) => i>0 && f.time>=time);
      if (end<0) end=frames.length-1;
      const a=frames[end-1], b=frames[end];
      const fraction = Math.min(1,Math.max(0,(time-a.time)/(b.time-a.time)));
      if (b.id===lastId && fraction===lastWeight) return false;
      lastId=b.id; lastWeight=fraction;
      const timed = startTimer(drawTiming);
      gl.viewport(0,0,width,height);
      gl.useProgram(present);
      bind(0,a.slot.image); bind(1,b.slot.image); bind(2,b.slot.motion);
      gl.uniform1f(weight,fraction);
      gl.drawArrays(gl.TRIANGLES,0,3);
      if (timed) gl.endQuery(timer.TIME_ELAPSED_EXT);
      return true;
    },
    dispose() {
      release();
      gl.deleteFramebuffer(fbo);
      for (const p of [compare,estimate,present]) gl.deleteProgram(p);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  };
}
