varying vec2 vUv;
varying vec2 cloudUV;
varying vec3 vColor;
uniform float iTime;

void main() {
  vUv = uv;
  cloudUV = uv;
  vColor = color;
  vec3 cpos = position;

  float waveSize = 10.0;
  float tipDistance = 0.3;
  float centerDistance = 0.1;

  // Wind animation based on vertex color (tip=white, center=gray, base=black)
  if (color.x > 0.6) {
    cpos.x += sin((iTime / 500.) + (uv.x * waveSize)) * tipDistance;
  } else if (color.x > 0.0) {
    cpos.x += sin((iTime / 500.) + (uv.x * waveSize)) * centerDistance;
  }

  float diff = position.x - cpos.x;
  cloudUV.x += iTime / 20000.;
  cloudUV.y += iTime / 10000.;

  vec4 worldPosition = vec4(cpos, 1.);
  vec4 mvPosition = projectionMatrix * modelViewMatrix * vec4(cpos, 1.0);
  gl_Position = mvPosition;
}
