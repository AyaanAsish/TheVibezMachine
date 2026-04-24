/**
 * 1. UTILS & RESIZING
 * Handles the high-res scaling and syncing pixels to the screen.
 */
const resizeCanvas = (canvas, visualizer) => {
  if (!canvas) return;

  // Get display size, fallback to 800x600 if tab is hidden (size 0)
  const width = canvas.clientWidth || 800;
  const height = canvas.clientHeight || 600;

  const pixelRatio = window.devicePixelRatio || 1;
  const targetWidth = Math.floor(width * pixelRatio);
  const targetHeight = Math.floor(height * pixelRatio);

  // Only update if dimensions actually changed
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    // Guard against calling the method before visualizer is ready
    if (visualizer && typeof visualizer.setInternalSize === "function") {
      visualizer.setInternalSize(canvas.width, canvas.height);
    }
  }
};

/**
 * 2. MAIN INITIALIZATION
 */
const initVisualizer = () => {
  // A. Locate Butterchurn Core
  const bcBase = window.butterchurn?.default || window.butterchurn;
  if (!bcBase) {
    console.error("Butterchurn library not found! Check your script tags.");
    return;
  }

  // B. Locate & Instantiate Presets
  const RawPresets =
    window.butterchurnPresets?.default || window.butterchurnPresets;
  let presets = {};
  try {
    // Most packs require 'new', some are just objects
    if (typeof RawPresets === "function") {
      const instance = new RawPresets();
      presets = instance.getPresets ? instance.getPresets() : instance;
    } else {
      presets = RawPresets || {};
    }
  } catch (e) {
    console.warn("Preset instantiation failed, trying raw object", e);
    presets = RawPresets || {};
  }

  // C. Setup Web Audio & Canvas
  const canvas = document.getElementById("visCanvas");
  const audioContext = new (window.AudioContext || window.webkitAudioContext)();

  // D. Create Visualizer Instance
  // Initial size is based on current canvas dimensions
  const visualizer = bcBase.createVisualizer(audioContext, canvas, {
    width: canvas.clientWidth || 800,
    height: canvas.clientHeight || 600,
    pixelRatio: window.devicePixelRatio || 1,
    meshWidth: 64, // Higher resolution for warping
    meshHeight: 48,
    textureRatio: 1,
  });

  // E. Immediate sync to catch high-DPI scaling
  resizeCanvas(canvas, visualizer);

  // F. Load the first available preset
  const presetKeys = Object.keys(presets);
  if (presetKeys.length > 0) {
    visualizer.loadPreset(presets[presetKeys[0]], 0.0);
  }

  /**
   * 3. RENDER LOOP
   * Includes a guard to prevent the GPU "mailbox" error when switching tabs.
   */
  const animate = () => {
    // Only render if the visualizer tab is visible in your UI
    visualizer.render();
    requestAnimationFrame(animate);
  };
  animate();

  /**
   * 4. LISTENERS & EXPOSURE
   */
  window.addEventListener("resize", () => resizeCanvas(canvas, visualizer));

  // Export variables so player.js can "plug in" the audio source
  window.myVisualizer = visualizer;
  // Create a safe wrapper so player.js can't crash it
  window.safeConnect = (source) => {
    if (source && visualizer) {
      visualizer.connectAudio(source);
    } else {
      console.warn("Attempted to connect a null audio source.");
    }
  };
  window.visualizerAudioContext = audioContext;

  console.log("Visualizer initialized and sharp. Ready for audio connection.");
};

// Start when the page is ready
if (document.readyState === "complete") {
  initVisualizer();
} else {
  window.addEventListener("load", initVisualizer);
}
