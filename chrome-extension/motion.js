// Pyramidal Lucas-Kanade flow at the temporal midpoint of two frames.
// Mip levels broaden the capture range; the final levels refine to subpixels.
const kittyFlowShader = `#version 300 es
precision highp float;
uniform sampler2D older, newer;
uniform vec2 gridSize;
out vec4 color;
float sampleY(sampler2D img, vec2 uv, float lod) {
  return dot(textureLod(img,uv,lod).rgb, vec3(.299,.587,.114));
}
void main() {
  vec2 uv = gl_FragCoord.xy / gridSize;
  vec2 size = vec2(textureSize(older,0)), px = 1. / size;
  float unit = max(1., size.x/1920.);
  vec2 flow = vec2(0.);
  float residual = 0.;
  for (int level=3; level>=0; --level) {
    float scale = exp2(float(level)) * unit, lod = log2(scale);
    vec2 dx=vec2(scale*px.x,0.), dy=vec2(0.,scale*px.y);
    for (int iter=0; iter<2; ++iter) {
      float xx=.00015, yy=.00015, xy=0.;
      vec2 rhs=vec2(0.);
      residual=0.;
      for (int y=-1; y<=1; ++y) for (int x=-1; x<=1; ++x) {
        vec2 loc=uv + vec2(x,y)*max(3.*unit,scale*1.5)*px;
        vec2 a=loc-.5*flow*px, b=loc+.5*flow*px;
        float t=sampleY(newer,b,lod)-sampleY(older,a,lod);
        vec2 grad=.5*vec2(sampleY(older,a+dx,lod)-sampleY(older,a-dx,lod),
                          sampleY(older,a+dy,lod)-sampleY(older,a-dy,lod));
        float robust=1./(1.+6.*abs(t));
        xx+=robust*grad.x*grad.x; yy+=robust*grad.y*grad.y; xy+=robust*grad.x*grad.y;
        rhs-=robust*grad*t; residual+=abs(t)/9.;
      }
      float det=xx*yy-xy*xy;
      vec2 delta=vec2(yy*rhs.x-xy*rhs.y,xx*rhs.y-xy*rhs.x)/max(det,1e-10);
      flow=clamp(flow+scale*clamp(delta,vec2(-1.75),vec2(1.75)),vec2(-31.*unit),vec2(31.*unit));
    }
  }
  color=vec4((vec2(128.)+flow/unit*4.)/255.,1.-smoothstep(.025,.12,residual),1.);
}`;
