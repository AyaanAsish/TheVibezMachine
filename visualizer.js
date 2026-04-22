const rawButterchurn = window.butterchurn;
const butterchurn = rawButterchurn?.default || rawButterchurn;

if (!butterchurn?.createVisualizer) {
  throw new Error("Butterchurn not loaded properly");
}

// presets is a FACTORY, not a map
const PresetFactory =
  window.butterchurnPresets?.default || window.butterchurnPresets;

const presetsInstance = PresetFactory(); // <-- THIS IS REQUIRED

const canvas = document.getElementById("visCanvas");
const audioContext = new AudioContext();

const visualizer = butterchurn.createVisualizer(audioContext, canvas, {
  width: canvas.width,
  height: canvas.height,
});

// get actual preset map
const presets = presetsInstance.getPresets();

// pick first safe preset
const firstKey = Object.keys(presets)[0];
visualizer.loadPreset(presets[firstKey], 0.0);

// render loop
function animate() {
  visualizer.render();
  requestAnimationFrame(animate);
}

animate();
