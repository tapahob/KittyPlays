const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {performance} = require('node:perf_hooks');
const source = fs.readFileSync(process.argv[2], 'utf8');
async function exercise(frames, interval, confidence) {
  let index=-1, timer, checks=0;
  const output=new Map(), rows=[];
  const video={
    readyState:4, videoWidth:1280,videoHeight:720, paused:false, currentTime:0, play:async()=>{},
    requestVideoFrameCallback(cb) {
      if (index+1<frames.length) timer=setTimeout(()=>{
        const [mediaTime]=frames[++index];
        cb(performance.now(),{mediaTime,presentedFrames:index+1});
      },interval);
      return timer;
    },
    cancelVideoFrameCallback(id){clearTimeout(id);}
  };
  const player={querySelector:()=>video,classList:{contains:()=>false},getVideoData:()=>({video_id:'fixture'})};
  const sampleBuffer=new Uint8ClampedArray(1280*720*4);
  const context={
    performance,setTimeout:(fn,delay)=>setTimeout(fn,delay===750?0:delay),
    document:{querySelector:selector=>selector==='#movie_player'?player:video,createElement:()=>({
      getContext:()=>({drawImage(){},getImageData:()=>({data:sampleBuffer})})
    })},
    VideoFrame:class{
      constructor(){const [,primaries,fullRange]=frames[index]; this.format='NV12';this.codedWidth=1280;this.codedHeight=720;this.visibleRect={width:1280,height:720};this.colorSpace={toJSON:()=>({primaries,transfer:'bt709',matrix:'bt709',fullRange})};}
      async copyTo(){await new Promise(resolve=>setTimeout(resolve,1));}
      close(){}
    },
    Uint8Array:class{toBase64(){return 'frame';}},
    window:{webkit:{messageHandlers:{
      framePort:{postMessage:async([pts,full])=>{output.set(pts,full);return true;}},
      rangePort:{postMessage:async([,,reported])=>{
        checks++;await new Promise(resolve=>setTimeout(resolve,reported?15:1));
        return {fullRange:!reported,confident:confidence};
      }}
    }}}
  };
  const capture=vm.runInNewContext(source+'\ncaptureKittyFrames',context);
  await capture({start:0,seconds:.22,videoId:'fixture'},r=>rows.push(r));
  assert.equal(rows.at(-1).failures,0);
  assert.equal(output.size,frames.length);
  for(const [pts,,reported] of frames)assert.equal(output.get(pts),!reported);
  return checks;
}
(async()=>{
  assert.equal(await exercise([[0,null,true],[.016,'bt709',true],[.033,null,true]],3,true),1);
  assert.equal(await exercise([[0,null,true],[.016,'bt709',false],[.033,null,true]],3,true),3);
  assert.equal(await exercise([[0,null,true],[1,'bt709',true],[15.1,null,true],[15.2,'bt709',true]],24,true),2);
  assert.equal(await exercise([[0,null,true],[.2,'bt709',true],[.51,null,true]],24,false),2);
  assert.equal(await exercise([[0,'bt709',true],[.1,'bt2020',true],[.2,'bt709',true]],24,true),3);
  console.log('PASS: equivalent primaries, overlapping profile changes, periodic and low-confidence rechecks, different primaries');
})().catch(err=>{console.error(err);process.exitCode=1;});
