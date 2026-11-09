// Pixel-art renderer: renders the 3D scene at a fraction of the screen
// resolution with depth/normal edge outlines (RenderPixelatedPass) and scales it
// up with nearest-neighbour sampling. Can be switched off at runtime.
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPixelatedPass } from 'three/addons/postprocessing/RenderPixelatedPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const KEY = 'plantaAppearance';

export function loadAppearance() {
  const def = { pixel: true, pixelSize: window.innerWidth < 860 ? 2 : 3 };
  try {
    return { ...def, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return def;
  }
}

export function saveAppearance(a) {
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch {}
}

export class PixelRenderer {
  constructor(renderer, scene, camera, appearance) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.composer = new EffectComposer(renderer);
    this.pass = new RenderPixelatedPass(appearance.pixelSize, scene, camera, { normalEdgeStrength: 0.35, depthEdgeStrength: 0.5 });
    this.composer.addPass(this.pass);
    this.composer.addPass(new OutputPass());
    this.set(appearance);
  }

  set({ pixel, pixelSize }) {
    this.enabled = !!pixel;
    this.pass.setPixelSize(Math.max(1, pixelSize || 3));
    // Pixel mode renders at 1 device pixel per CSS pixel; normal mode uses the screen DPR.
    this.renderer.setPixelRatio(this.enabled ? 1 : Math.min(window.devicePixelRatio, 2));
    if (this.w) this.setSize(this.w, this.h);
  }

  setSize(w, h) {
    this.w = w;
    this.h = h;
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
  }

  render() {
    if (this.enabled) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
