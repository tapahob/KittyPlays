// Adapted from the FidelityFX SDK 1.1.4 Optical Flow and Frame Interpolation shaders.
// Copyright (C) 2024 Advanced Micro Devices, Inc.
// Licensed under the MIT License. See fidelityfx-LICENSE.txt.

const kittyFidelityFxShaders = {
  luma: `
    @group(0) @binding(0) var color: texture_2d<f32>;
    @group(0) @binding(1) var output: texture_storage_2d<r32uint, write>;

    @compute @workgroup_size(8, 8)
    fn main(@builtin(global_invocation_id) id: vec3<u32>) {
      if (any(id.xy >= textureDimensions(output))) { return; }
      let rgb = textureLoad(color, vec2<i32>(id.xy), 0).rgb;
      let luma = u32(clamp(dot(rgb, vec3<f32>(0.2126, 0.7152, 0.0722)), 0.0, 1.0) * 255.0);
      textureStore(output, vec2<i32>(id.xy), vec4<u32>(luma, 0, 0, 0));
    }`,

  downsample: `
    @group(0) @binding(0) var source: texture_2d<u32>;
    @group(0) @binding(1) var output: texture_storage_2d<r32uint, write>;

    @compute @workgroup_size(8, 8)
    fn main(@builtin(global_invocation_id) id: vec3<u32>) {
      if (any(id.xy >= textureDimensions(output))) { return; }
      let p = vec2<i32>(id.xy * 2u);
      let limit = vec2<i32>(textureDimensions(source)) - 1;
      var sum = 0u;
      for (var y = 0; y < 2; y++) {
        for (var x = 0; x < 2; x++) {
          sum += textureLoad(source, min(p + vec2<i32>(x, y), limit), 0).r;
        }
      }
      textureStore(output, vec2<i32>(id.xy), vec4<u32>((sum + 2u) / 4u, 0, 0, 0));
    }`,

  // 8x8 luminance blocks, hierarchical SAD search, and the SDK's near-zero tie break.
  // The lower levels refine the prediction over a smaller window for video playback.
  search: `
    override radius: i32 = 2;
    override usePrediction: bool = false;
    override tryLocal: bool = false;
    @group(0) @binding(0) var current: texture_2d<u32>;
    @group(0) @binding(1) var previous: texture_2d<u32>;
    @group(0) @binding(2) var coarser: texture_2d<i32>;
    @group(0) @binding(3) var output: texture_storage_2d<rg32sint, write>;
    var<workgroup> block: array<i32, 64>;
    var<workgroup> region: array<i32, 576>;
    var<workgroup> predictions: array<vec2<i32>, 4>;
    var<workgroup> seed: atomic<u32>;
    var<workgroup> best: atomic<u32>;

    fn luma(image: texture_2d<u32>, pos: vec2<i32>) -> i32 {
      let edge = vec2<i32>(textureDimensions(image)) - 1;
      return i32(textureLoad(image, clamp(pos, vec2<i32>(0), edge), 0).r);
    }

    @compute @workgroup_size(64)
    fn main(@builtin(workgroup_id) id: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
      let cell = vec2<i32>(id.xy);
      let origin = cell * 8;
      let local = vec2<i32>(i32(lane % 8u), i32(lane / 8u));
      block[lane] = luma(current, origin + local);
      if (lane == 0u) {
        atomicStore(&seed, 0xffffffffu);
        atomicStore(&best, 0xffffffffu);
      }
      workgroupBarrier();

      if (usePrediction && lane < 4u) {
        let neighbor = cell / 2 + cell % 2 - 1 + vec2<i32>(i32(lane % 2u), i32(lane / 2u));
        let edge = vec2<i32>(textureDimensions(coarser)) - 1;
        let vector = textureLoad(coarser, clamp(neighbor, vec2<i32>(0), edge), 0).xy * 2;
        predictions[lane] = vector;
        var error = 0u;
        for (var y = 0; y < 4; y++) {
          for (var x = 0; x < 4; x++) {
            let pos = vec2<i32>(x + 2, y + 2);
            error += u32(abs(block[u32(pos.y * 8 + pos.x)] - luma(previous, origin + pos + vector)));
          }
        }
        atomicMin(&seed, (error << 2u) | lane);
      }
      workgroupBarrier();

      var prediction = vec2<i32>(0);
      if (usePrediction) { prediction = predictions[atomicLoad(&seed) & 3u]; }
      let diameter = radius * 2;
      let side = 8 + diameter;
      var candidate = 0xffffffffu;
      for (var attempt = 0u; attempt < select(1u, 2u, tryLocal); attempt++) {
        let center = select(prediction, vec2<i32>(0), attempt == 1u);
        for (var n = i32(lane); n < side * side; n += 64) {
          let point = origin + center + vec2<i32>(n % side, n / side) - radius;
          region[n] = luma(previous, point);
        }
        workgroupBarrier();

        for (var n = i32(lane); n < diameter * diameter; n += 64) {
          let x = n % diameter;
          let y = n / diameter;
          var sad = 0u;
          for (var row = 0; row < 8; row++) {
            let src = row * 8;
            let reference = (y + row) * side + x;
            for (var col = 0; col < 8; col++) {
              sad += u32(abs(block[src + col] - region[reference + col]));
            }
          }
          let vector = abs(center + vec2<i32>(x, y) - radius);
          let distance = u32(vector.x + vector.y);
          // A local hypothesis guards against periodic matches in coarse luma.
          let score = sad + select(0u, min(32u, distance) * 8u, tryLocal);
          let tie = min(distance, 127u) << 9u;
          candidate = min(candidate, (score << 16u) | tie | (attempt << 8u) | u32(y * 16 + x));
        }
        workgroupBarrier();
      }
      atomicMin(&best, candidate);
      workgroupBarrier();
      if (lane == 0u) {
        let matchCode = atomicLoad(&best);
        let center = select(prediction, vec2<i32>(0), (matchCode & 256u) != 0u);
        var motion = center + vec2<i32>(i32(matchCode & 15u), i32((matchCode >> 4u) & 15u)) - radius;
        if (usePrediction) {
          var staticSad = 0u;
          for (var y = 0; y < 8; y++) {
            for (var x = 0; x < 8; x++) {
              staticSad += u32(abs(block[y * 8 + x] - luma(previous, origin + vec2<i32>(x, y))));
            }
          }
          if (staticSad <= (matchCode >> 16u)) { motion = vec2<i32>(0); }
        }
        textureStore(output, cell, vec4<i32>(motion, 0, 0));
      }
    }`,

  // SDK 3x3 vector medoid. Comparing distances to the mean preserves the ranking.
  filter: `
    @group(0) @binding(0) var raw: texture_2d<i32>;
    @group(0) @binding(1) var output: texture_storage_2d<rg32sint, write>;

    @compute @workgroup_size(8, 8)
    fn main(@builtin(global_invocation_id) id: vec3<u32>) {
      if (any(id.xy >= textureDimensions(output))) { return; }
      let point = vec2<i32>(id.xy);
      let edge = vec2<i32>(textureDimensions(raw)) - 1;
      var motion: array<vec2<i32>, 9>;
      var sum = vec2<i32>(0);
      for (var x = 0; x < 3; x++) {
        for (var y = 0; y < 3; y++) {
          let neighbor = clamp(point + vec2<i32>(x - 1, y - 1), vec2<i32>(0), edge);
          let value = textureLoad(raw, neighbor, 0).xy;
          motion[x * 3 + y] = value;
          sum += value;
        }
      }
      var selected = motion[4];
      var minimum = 0xffffffffu;
      for (var i = 0; i < 9; i++) {
        let delta = motion[i] * 9 - sum;
        let distance = u32(delta.x * delta.x + delta.y * delta.y);
        if (distance < minimum) {
          minimum = distance;
          selected = motion[i];
        }
      }
      textureStore(output, point, vec4<i32>(selected, 0, 0));
    }`,

  // Regional luma histograms and symmetric divergence, reduced entirely on the GPU.
  scene: `
    @group(0) @binding(0) var current: texture_2d<u32>;
    @group(0) @binding(1) var previous: texture_2d<u32>;
    @group(0) @binding(2) var<storage, read_write> divergence: array<f32>;
    var<workgroup> histCurrent: array<atomic<u32>, 64>;
    var<workgroup> histPrevious: array<atomic<u32>, 64>;
    var<workgroup> score: array<f32, 64>;

    @compute @workgroup_size(64)
    fn main(@builtin(workgroup_id) id: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
      let dims = textureDimensions(current);
      let start = id.xy * dims / 3u;
      let span = (id.xy + 1u) * dims / 3u - start;
      let pixels = span.x * span.y;
      for (var i = lane; i < pixels; i += 64u) {
        let pos = vec2<i32>(start + vec2<u32>(i % span.x, i / span.x));
        atomicAdd(&histCurrent[textureLoad(current, pos, 0).r / 4u], 1u);
        atomicAdd(&histPrevious[textureLoad(previous, pos, 0).r / 4u], 1u);
      }
      workgroupBarrier();

      let a = f32(atomicLoad(&histCurrent[lane])) + 0.25;
      let b = f32(atomicLoad(&histPrevious[lane])) + 0.25;
      score[lane] = (a - b) * log(a / b);
      for (var size = 32u; size > 0u; size /= 2u) {
        workgroupBarrier();
        if (lane < size) { score[lane] += score[lane + size]; }
      }
      if (lane == 0u) {
        divergence[id.y * 3u + id.x] = 1.0 - exp(-score[0] / (f32(pixels) + 16.0));
      }
    }`,

  // Keep one confidence-ranked motion field per source pair. Projection
  // depends on presentation time, but the optical flow does not.
  project: `
    @group(0) @binding(0) var motion: texture_2d<i32>;
    @group(0) @binding(1) var current: texture_2d<u32>;
    @group(0) @binding(2) var previous: texture_2d<u32>;
    @group(0) @binding(3) var<storage, read_write> vectors: array<vec2<f32>>;
    @group(0) @binding(4) var<storage, read_write> entries: array<u32>;
    @group(0) @binding(5) var<storage, read> divergence: array<f32>;

    @compute @workgroup_size(8, 8)
    fn main(@builtin(global_invocation_id) id: vec3<u32>) {
      let grid = textureDimensions(motion);
      if (any(id.xy >= grid)) { return; }
      let index = id.y * grid.x + id.x;
      entries[index] = 0u;
      var scene = 0.0;
      for (var i = 0u; i < 9u; i++) { scene += divergence[i]; }
      if (scene > 9.0 * 0.45) { return; }
      let cell = vec2<i32>(id.xy);
      var samples: array<vec2<f32>, 9>;
      var weights: array<f32, 9>;
      var mean = vec2<f32>(0.0);
      var weight = 0.0;
      for (var i = 0; i < 9; i++) {
        let neighbor = clamp(cell + vec2<i32>(i % 3 - 1, i / 3 - 1), vec2<i32>(0), vec2<i32>(grid) - 1);
        let value = vec2<f32>(textureLoad(motion, neighbor, 0).xy);
        let speed = length(value);
        let w = select(0.0, max(0.0, 512.0 - speed), speed > 1.0);
        samples[i] = value;
        weights[i] = w;
        mean += value * w;
        weight += w;
      }
      if (weight == 0.0) { return; }
      mean /= weight;
      var vector = vec2<f32>(0.0);
      weight = 0.0;
      for (var i = 0; i < 9; i++) {
        let w = weights[i] * pow(max(0.0, dot(mean, samples[i])), 1.25);
        vector += samples[i] * w;
        weight += w;
      }
      if (weight == 0.0) { return; }
      vector /= weight;
      let size = vec2<i32>(textureDimensions(current));
      let currentPos = min(cell * 8 + 4, size - 1);
      let previousPos = currentPos + vec2<i32>(round(vector));
      let a = 1.0 + f32(textureLoad(current, currentPos, 0).r);
      let b = 1.0 + f32(textureLoad(previous, clamp(previousPos, vec2<i32>(0), size - 1), 0).r);
      let confidence = select(0u, u32(round(min(a, b) / max(a, b) * 63.0)),
        all(previousPos >= vec2<i32>(0)) && all(previousPos < size));
      let priority = max(1u, u32(clamp(length(vector) / (length(vec2<f32>(size)) * 0.05), 0.0, 1.0) * 63.0));
      entries[index] = (priority << 26u) | (confidence << 20u) | index;
      vectors[index] = vector;
    }`,

  scatter: `
    @group(0) @binding(0) var<storage, read> vectors: array<vec2<f32>>;
    @group(0) @binding(1) var<storage, read> entries: array<u32>;
    @group(0) @binding(2) var<storage, read_write> projected: array<atomic<u32>>;
    struct Phase { grid: vec2<u32>, t: f32 }
    @group(0) @binding(3) var<uniform> phase: Phase;

    @compute @workgroup_size(8, 8)
    fn main(@builtin(global_invocation_id) id: vec3<u32>) {
      let grid = phase.grid;
      if (any(id.xy >= grid)) { return; }
      let index = id.y * grid.x + id.x;
      let entry = entries[index];
      if (entry == 0u) { return; }
      let base = vec2<i32>(floor(vec2<f32>(id.xy) + vectors[index] * ((1.0 - phase.t) / 8.0)));
      for (var y = 0; y < 2; y++) {
        for (var x = 0; x < 2; x++) {
          let destination = base + vec2<i32>(x, y);
          if (all(destination >= vec2<i32>(0)) && all(destination < vec2<i32>(grid))) {
            atomicMax(&projected[u32(destination.y) * grid.x + u32(destination.x)], entry);
          }
        }
      }
    }`,

  // The video has neither game motion vectors nor a depth buffer. Use the
  // unwarped pair as the stationary candidate in the SDK's color comparison.
  interpolate: format => `
    @group(0) @binding(0) var previous: texture_2d<f32>;
    @group(0) @binding(1) var current: texture_2d<f32>;
    @group(0) @binding(2) var linear: sampler;
    @group(0) @binding(3) var<storage, read> vectors: array<vec2<f32>>;
    @group(0) @binding(4) var<storage, read> projected: array<u32>;
    @group(0) @binding(5) var<storage, read> divergence: array<f32>;
    @group(0) @binding(6) var output: texture_storage_2d<${format}, write>;
    struct Phase { grid: vec2<u32>, t: f32 }
    @group(0) @binding(7) var<uniform> phase: Phase;

    fn similarity(a: vec3<f32>, b: vec3<f32>) -> f32 {
      let m = max(dot(a, a), dot(b, b));
      return select(1.0, dot(a, b) / max(m, 1e-8), m > 0.0);
    }

    @compute @workgroup_size(8, 8)
    fn main(@builtin(global_invocation_id) id: vec3<u32>) {
      let size = textureDimensions(output);
      if (any(id.xy >= size)) { return; }
      let pixel = vec2<i32>(id.xy);
      let older = textureLoad(previous, pixel, 0).rgb;
      let newer = textureLoad(current, pixel, 0).rgb;
      var scene = 0.0;
      for (var i = 0u; i < 9u; i++) { scene += divergence[i]; }
      var color = select(older, newer, phase.t >= 0.5);
      if (scene <= 9.0 * 0.45) {
        let grid = (size + 7u) / 8u;
        let p = (vec2<f32>(pixel) + 0.5) / 8.0 - 0.5;
        let base = vec2<i32>(floor(p));
        let f = fract(p);
        var vector = vec2<f32>(0.0);
        for (var y = 0; y < 2; y++) {
          for (var x = 0; x < 2; x++) {
            let q = vec2<u32>(clamp(base + vec2<i32>(x, y), vec2<i32>(0), vec2<i32>(grid) - 1));
            let hit = projected[q.y * grid.x + q.x];
            if (hit != 0u) {
              let wx = select(1.0 - f.x, f.x, x != 0);
              let wy = select(1.0 - f.y, f.y, y != 0);
              vector += vectors[hit & 0xfffffu] * wx * wy;
            }
          }
        }
        let uv = (vec2<f32>(pixel) + 0.5) / vec2<f32>(size);
        let offset = vector / vec2<f32>(size);
        let oldUV = uv + offset * phase.t;
        let newUV = uv - offset * (1.0 - phase.t);
        let a = textureSampleLevel(previous, linear, oldUV, 0.0).rgb;
        let b = textureSampleLevel(current, linear, newUV, 0.0).rgb;
        let oldVisible = all(oldUV >= vec2<f32>(0.0)) && all(oldUV <= vec2<f32>(1.0));
        let newVisible = all(newUV >= vec2<f32>(0.0)) && all(newUV <= vec2<f32>(1.0));
        let optical = mix(a, b, select(select(1.0, 0.0, oldVisible), phase.t, oldVisible && newVisible));
        let baseColor = mix(older, newer, phase.t);
        // Favor a projected pair only when its samples agree more closely.
        let staticError = 1.0 - similarity(older, newer);
        let flowError = 1.0 - similarity(a, b);
        let bias = clamp(flowError / max(1e-4, staticError), 0.0, 1.0);
        color = mix(optical, baseColor, bias);
      }
      textureStore(output, pixel, vec4<f32>(color, 1.0));
    }`,
};
