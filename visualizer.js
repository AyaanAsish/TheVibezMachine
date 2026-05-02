/**
 * 1. UTILS & RESIZING
 */
const resizeCanvas = (canvas, visualizer) => {
  if (!canvas) return;
  const width = canvas.clientWidth || 800;
  const height = canvas.clientHeight || 600;
  const pixelRatio = window.devicePixelRatio || 1;
  const targetWidth = Math.floor(width * pixelRatio);
  const targetHeight = Math.floor(height * pixelRatio);

  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    if (visualizer && typeof visualizer.setInternalSize === "function") {
      visualizer.setInternalSize(canvas.width, canvas.height);
    }
  }
};

/**
 * 2. MAIN INITIALIZATION
 */
const initVisualizer = () => {
  const bcBase = window.butterchurn?.default || window.butterchurn;
  if (!bcBase) return;

  window.butterchurnPresets?.default || window.butterchurnPresets;
  let presets = {};
  try {
    const RawPresets =
      window.butterchurnPresets?.default || window.butterchurnPresets;
    presets = RawPresets.getPresets ? RawPresets.getPresets() : RawPresets;
    console.log("[Visualizer] Preset count:", Object.keys(presets).length);
  } catch (e) {
    console.error("[Visualizer] Preset load error:", e);
  }

  const canvas = document.getElementById("visCanvas");
  const audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const visualizer = bcBase.createVisualizer(audioContext, canvas, {
    width: canvas.clientWidth,
    height: canvas.clientHeight,
    pixelRatio: window.devicePixelRatio || 1,
    meshWidth: 64,
    meshHeight: 48,
    textureRatio: 1,
  });

  resizeCanvas(canvas, visualizer);

  const presetKeys = Object.keys(presets);
  if (presetKeys.length > 0) {
    visualizer.loadPreset(presets[presetKeys[0]], 0.0);
  }

  // PRESET LIST GENERATION (Inside the function scope)
  const listContainer = document.getElementById("preset-list");
  const overlay = document.getElementById("preset-overlay");
  const toggleBtn = document.getElementById("preset-toggle");

  if (listContainer && presetKeys.length > 0) {
    listContainer.innerHTML = "";
    presetKeys.forEach((name) => {
      const btn = document.createElement("button");
      btn.className = "preset-button";
      btn.textContent = name.replace(/_/g, " ");
      btn.onclick = () => {
        visualizer.loadPreset(presets[name], 2.0);
        document
          .querySelectorAll(".preset-button")
          .forEach((b) => b.classList.remove("active-preset"));
        btn.classList.add("active-preset");
        const label = document.getElementById("preset-current-name");
        if (label) label.textContent = name.replace(/_/g, " ");
        document.getElementById("preset-dropdown").classList.remove("open");
      };
      listContainer.appendChild(btn);
    });
    if (listContainer.firstChild)
      listContainer.firstChild.classList.add("active-preset");
  }

  if (toggleBtn) {
    const dropdown = document.getElementById("preset-dropdown");
    toggleBtn.onclick = () => {
      dropdown.classList.toggle("open");
    };
    // Close if clicking outside
    document.addEventListener("click", (e) => {
      if (!toggleBtn.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.classList.remove("open");
      }
    });
  }

  /**
   * 3. RENDER LOOP
   */
  const animate = () => {
    visualizer.render();
    requestAnimationFrame(animate);
  };
  animate();

  /**
   * 4. LISTENERS & EXPOSURE
   */
  window.addEventListener("resize", () => resizeCanvas(canvas, visualizer));
  window.myVisualizer = visualizer;
  window.visualizerAudioContext = audioContext;
  window.safeConnect = (source) => {
    if (source && visualizer) visualizer.connectAudio(source);
  };
};

if (document.readyState === "complete") {
  initVisualizer();
} else {
  window.addEventListener("load", initVisualizer);
}
