/**
 * 1. UTILS & RESIZING
 */
const resizeCanvas = (canvas, visualizer) => {
  if (!canvas) return;
  const width = canvas.clientWidth || 800;
  const height = canvas.clientHeight || 600;

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    if (visualizer && typeof visualizer.setRendererSize === "function") {
      visualizer.setRendererSize(width, height);
    }
  }
};

/**
 * 2. MAIN INITIALIZATION
 */
const initVisualizer = () => {
  const bcBase = window.butterchurn?.default || window.butterchurn;
  if (!bcBase) return;

  const favPresets = [
    "flexi + amandio c - organic12-3d-2.milk",
    "martin - castle in the air",
    "martin - ghost city",
    "martin - mandelbox explorer - high speed demo version",
    "martin - mucus cervix",
    "martin - stormy sea (2010 update)",
    "Cope - The Neverending Explosion of Red Liquid Fire",
    "_Geiss - Artifact 01",
  ];

  let presets = {};
  try {
    const RawPresets =
      window.butterchurnPresets?.default || window.butterchurnPresets;
    presets = RawPresets.getPresets ? RawPresets.getPresets() : RawPresets;
  } catch (e) {
    console.error("[Visualizer] Preset load error:", e);
  }

  const canvas = document.getElementById("visCanvas");
  const audioContext = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: 44100,
  });
  const visualizer = bcBase.createVisualizer(audioContext, canvas, {
    width: canvas.clientWidth,
    height: canvas.clientHeight,
    pixelRatio: window.devicePixelRatio || 1,
    meshWidth: 64,
    meshHeight: 48,
    textureRatio: 1,
  });

  resizeCanvas(canvas, visualizer);

  // 2. Map and filter your custom list against what's loaded in the library
  const presetKeys = favPresets.filter((name) => presets[name] !== undefined);
  let currentPresetIdx = 0;

  // 3. Keep your fallback block exactly as is just in case a typo slips through later!
  if (presetKeys.length === 0) {
    console.log(
      "[Visualizer] No custom presets matched. Defaulting to all available keys...",
    );
    presetKeys.push(...Object.keys(presets));
  }

  // 4. Load the very first preset from your handpicked list on start
  if (presetKeys.length > 0) {
    visualizer.loadPreset(presets[presetKeys[0]], 0.0);
  }

  function setPresetByIndex(idx) {
    if (!presetKeys.length) return;
    currentPresetIdx =
      ((idx % presetKeys.length) + presetKeys.length) % presetKeys.length;
    const name = presetKeys[currentPresetIdx];
    visualizer.loadPreset(presets[name], 2.0);
    document
      .querySelectorAll(".preset-button")
      .forEach((b) => b.classList.remove("active-preset"));
    const buttons = document.querySelectorAll(".preset-button");
    if (buttons[currentPresetIdx])
      buttons[currentPresetIdx].classList.add("active-preset");
    const label = document.getElementById("preset-current-name");
    if (label) label.textContent = name.replace(/_/g, " ");
    document.getElementById("preset-dropdown").classList.remove("open");
  }

  // PRESET LIST GENERATION (Inside the function scope)
  const listContainer = document.getElementById("preset-list");
  const toggleBtn = document.getElementById("preset-toggle");

  if (listContainer && presetKeys.length > 0) {
    listContainer.innerHTML = "";
    presetKeys.forEach((name) => {
      const btn = document.createElement("button");
      btn.className = "preset-button";
      btn.textContent = name.replace(/_/g, " ");
      btn.onclick = () => {
        const idx = presetKeys.indexOf(name);
        if (idx !== -1) setPresetByIndex(idx);
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
  document.addEventListener("keydown", (e) => {
    if (window.isUserTyping && window.isUserTyping()) return;
    if (activeTab !== "visualizer") return;
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setPresetByIndex(currentPresetIdx - 1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setPresetByIndex(currentPresetIdx + 1);
    }
  });

  window.addEventListener("resize", () => resizeCanvas(canvas, visualizer));
  window.myVisualizer = visualizer;
  window.visualizerAudioContext = audioContext;
};

if (document.readyState === "complete") {
  initVisualizer();
} else {
  window.addEventListener("load", initVisualizer);
}
