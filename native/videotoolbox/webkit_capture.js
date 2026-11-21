// In an app-owned WKWebView, measure the cost of moving a permitted SDR frame
// across the public script-message bridge. A bounded number of replies may be pending.
async function captureKittyFrames(options, report) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (check, ms, stage) => {
    const end = performance.now() + ms;
    while (!check()) {
      if (performance.now() >= end) throw Error('Timed out: '+stage+' ('+document.title+', '+document.querySelector('video')?.videoWidth+'px)');
      await sleep(100);
    }
  };
  await wait(() => document.querySelector('video')?.readyState >= 1, 35000, 'metadata');
  let video, player, lastQualityRequest = -Infinity;
  await wait(() => {
    player = document.querySelector('#movie_player');
    const current = player?.querySelector('video.html5-main-video, video') ?? document.querySelector('video');
    if (!current) return false;
    if (video !== current || current.paused) {
      video = current;
      video.muted = true;
      video.playsInline = true;
      video.play().catch(() => {});
    }
    if (player?.classList.contains('ad-showing') || video.mediaKeys) return false;
    if (performance.now()-lastQualityRequest > 2500) {
      lastQualityRequest = performance.now();
      player?.setPlaybackQualityRange?.('hd720', 'hd720');
    }
    return video.videoWidth === 1280 && video.videoHeight === 720;
  }, 55000, '720p programme');
  video.currentTime = options.start;
  await wait(() => video.readyState >= 2 && !video.seeking && Math.abs(video.currentTime - options.start) < 3, 15000, 'seek');
  await sleep(750);
  const stats = () => player?.getStatsForNerds?.();
  const identity = () => player?.getVideoData?.()?.video_id ?? new URL(location.href).searchParams.get('v');
  if (identity() !== options.videoId) throw Error('Unexpected source video');
  report({event:'captureStart', title:document.title, sourceId:player?.getVideoData?.()?.video_id,
    resolution:stats()?.resolution, color:stats()?.color, codec:stats()?.codecs});
  const port = window.webkit.messageHandlers.framePort;
  const rangePort = window.webkit.messageHandlers.rangePort;
  let rangeState;
  const observedPrimaries = new Set();
  const rangeChecks=[];
  const reference = document.createElement('canvas');
  reference.width=1280; reference.height=720;
  const sampleContext=reference.getContext('2d',{colorSpace:'srgb',willReadFrequently:true});
  function referenceSamples() {
    sampleContext.drawImage(video,0,0,1280,720);
    const rgb=sampleContext.getImageData(0,0,1280,720).data;
    const points=[];
    for (let y=24; y<720; y+=60) for (let x=32; x<1280; x+=80) {
      const i=4*(y*1280+x);
      points.push([x,y,rgb[i],rgb[i+1],rgb[i+2]]);
    }
    return points;
  }
  const a = { callbacks:0, skippedBusy:0, sent:0, rejected:0, failures:0, invalid:0, errors:[], copy:[], pack:[], reply:[] };
  const inFlight = new Set();
  let profile, firstTime, latestTime, vf, lastReason, lastRequest=0;
  let firstPresented, lastPresented;
  const qualityBefore = video.getVideoPlaybackQuality?.();
  const transitions = [];
  async function sendFrame(meta) {
    const frame = new VideoFrame(video);
    try {
      const color = frame.colorSpace?.toJSON?.();
      if (frame.format !== 'NV12' || frame.codedWidth !== 1280 || frame.codedHeight !== 720 ||
          frame.visibleRect.width !== 1280 || frame.visibleRect.height !== 720 ||
          color?.matrix !== 'bt709' || color?.transfer !== 'bt709' || typeof color?.fullRange !== 'boolean') {
        a.invalid++;
        if (a.errors.length < 1) a.errors.push(JSON.stringify({format:frame.format, color}));
        return;
      }
      const layout = [{offset:0, stride:1280}, {offset:921600, stride:1280}];
      const bytes = new Uint8Array(1382400);
      // The native SDR pipeline uses BT.709 primaries when WebKit omits them.
      const primaries = color.primaries ?? 'bt709';
      observedPrimaries.add(color.primaries ?? null);
      if (!rangeState || rangeState.primaries !== primaries || rangeState.reportedFull !== color.fullRange) {
        rangeState = {primaries, reportedFull:color.fullRange, checkedAt:-Infinity, result:null, pending:null};
      }
      const state = rangeState;
      const age = meta.mediaTime - state.checkedAt;
      const due = !state.result || age < 0 || age > (state.result.confident ? 15 : .5);
      // Sample the same video pose synchronously, before copyTo yields to the next frame.
      const samples=rangePort && due && !state.pending ? referenceSamples() : null;
      const t = performance.now();
      let u, v;
      const encoded = frame.copyTo(bytes,{layout}).then(() => {
        u = performance.now();
        const packet = bytes.toBase64();
        v = performance.now();
        return packet;
      });
      if (samples) {
        state.pending = encoded.then(packet => rangePort.postMessage([packet,samples,color.fullRange])).then(result=>{
          state.result = result;
          state.checkedAt = meta.mediaTime;
          rangeChecks.push({time:meta.mediaTime,reportedFullRange:color.fullRange,...result});
          return result;
        }).finally(()=>{state.pending=null;});
      }
      const [packet, decision] = await Promise.all([encoded, state.pending ?? state.result]);
      const fullRange=decision?.fullRange ?? color.fullRange;
      profile = {format:frame.format, color, copiedFullRange:fullRange};
      const accepted = await port.postMessage([meta.mediaTime, fullRange, packet]);
      a.copy.push(u-t); a.pack.push(v-u); a.reply.push(performance.now()-v);
      if (accepted) a.sent++; else a.rejected++;
    } finally { frame.close(); }
  }
  const started = performance.now();
  await new Promise(resolve => {
    function capture(_, meta) {
      vf = video.requestVideoFrameCallback(capture);
      const reason = player?.classList.contains('ad-showing') ? 'ad' : video.mediaKeys ? 'protected' :
        video.seeking ? 'seek' : identity() !== options.videoId ? 'source' :
        video.videoWidth !== 1280 || video.videoHeight !== 720 ? video.videoWidth+'x'+video.videoHeight : 'ok';
      if (reason !== lastReason) {
        if (transitions.length < 30) transitions.push({reason, pts:meta.mediaTime});
        lastReason = reason;
      }
      if (reason !== 'ok') {
        a.invalid++;
        if (/^\d+x\d+$/.test(reason) && performance.now()-lastRequest>3000) {
          lastRequest=performance.now(); player?.setPlaybackQualityRange?.('hd720','hd720');
        }
        return;
      }
      a.callbacks++;
      firstTime ??= meta.mediaTime;
      latestTime = meta.mediaTime;
      firstPresented ??= meta.presentedFrames;
      lastPresented = meta.presentedFrames;
      if (options.sourceOnly) return;
      if (inFlight.size >= 3) { a.skippedBusy++; return; }
      const job = sendFrame(meta).catch(e => { a.failures++; if(a.errors.length<3) a.errors.push(String(e)); });
      inFlight.add(job);
      job.finally(() => inFlight.delete(job));
    }
    vf = video.requestVideoFrameCallback(capture);
    setTimeout(() => { video.cancelVideoFrameCallback(vf); resolve(); }, options.seconds*1000);
  });
  await Promise.all(inFlight);
  const times = {};
  for (const key of ['copy','pack','reply']) {
    const x = a[key].sort((x,y)=>x-y); delete a[key];
    times[key+'P50Ms'] = x.length ? x[Math.ceil(x.length*.5)-1] : null;
    times[key+'P95Ms'] = x.length ? x[Math.ceil(x.length*.95)-1] : null;
  }
  const qualityAfter = video.getVideoPlaybackQuality?.();
  report({event:'captureEnd', seconds:(performance.now()-started)/1000, firstTime, latestTime, profile, transitions,
    sourceOnly: !!options.sourceOnly, observedPrimaries:[...observedPrimaries], rangeChecks, compositorFrames: lastPresented != null ? lastPresented-firstPresented+1 : null,
    videoDroppedFrames: qualityAfter && qualityBefore ? qualityAfter.droppedVideoFrames-qualityBefore.droppedVideoFrames : null,
    endMediaTime:video.currentTime, duration:video.duration, playerResolution:stats()?.resolution, ...a, ...times});
}
