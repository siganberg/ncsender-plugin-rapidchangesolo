/**
 * Rapid Change Solo plugin
 * Simple rapid tool change workflow helper for manual tool changers.
 */

const ORIENTATIONS = ['X', 'Y'];
const DIRECTIONS = ['Positive', 'Negative'];

const sanitizeOrientation = (value) => (ORIENTATIONS.includes(value) ? value : 'Y');
const sanitizeDirection = (value) => (DIRECTIONS.includes(value) ? value : 'Negative');
const toFiniteNumber = (value, fallback = 0) => {
  const num = Number.parseFloat(value);
  return Number.isFinite(num) ? num : fallback;
};

const sanitizeCoords = (coords = {}) => ({
  x: toFiniteNumber(coords.x),
  y: toFiniteNumber(coords.y)
});

const buildInitialConfig = (raw = {}) => ({
  // UI Settings
  orientation: sanitizeOrientation(raw.orientation),
  direction: sanitizeDirection(raw.direction),

  // Position Settings
  pocket1: sanitizeCoords(raw.pocket1),

  // Advanced Settings (no UI, JSON only)
  // Z-axis Settings
  zEngagement: toFiniteNumber(raw.zEngagement, -50),
  zSafe: toFiniteNumber(raw.zSafe, 0),
  zSpinOff: toFiniteNumber(raw.zSpinOff, 23),
  zRetreat: toFiniteNumber(raw.zRetreat, 7),

  // Tool Change Settings
  unloadRpm: toFiniteNumber(raw.unloadRpm, 1500),
  loadRpm: toFiniteNumber(raw.loadRpm, 1200),
  engageFeedrate: toFiniteNumber(raw.engageFeedrate, 3500),

  // Tool Length Setter Settings
  pocketDistance: toFiniteNumber(raw.pocketDistance, 45),
  zProbeStart: toFiniteNumber(raw.zProbeStart, -10),
  seekDistance: toFiniteNumber(raw.seekDistance, 50),
  seekFeedrate: toFiniteNumber(raw.seekFeedrate, 500)
});

const resolveServerPort = (pluginSettings = {}, appSettings = {}) => {
  const appPort = Number.parseInt(appSettings?.senderPort, 10);
  if (Number.isFinite(appPort)) {
    return appPort;
  }

  const pluginPort = Number.parseInt(pluginSettings?.port, 10);
  if (Number.isFinite(pluginPort)) {
    return pluginPort;
  }

  return 8090;
};

// Helper: Format and split G-code into array of commands
const formatGCode = (gcode) => {
  return gcode
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
};

// Helper: Compute tool setter position based on orientation and direction
function computeToolSetterPosition(settings) {
  const directionMultiplier = settings.direction === 'Negative' ? -1 : 1;

  if (settings.orientation === 'Y') {
    return {
      x: settings.pocket1.x,
      y: settings.pocket1.y + (settings.pocketDistance * directionMultiplier)
    };
  } else {
    return {
      x: settings.pocket1.x + (settings.pocketDistance * directionMultiplier),
      y: settings.pocket1.y
    };
  }
}

// Helper: Create tool length setter routine
function createToolLengthSetRoutine(settings) {
  const toolSetter = computeToolSetterPosition(settings);
  return `
    G53 G0 Z${settings.zSafe}
    G53 G0 X${toolSetter.x} Y${toolSetter.y}
    G53 G0 Z${settings.zProbeStart}
    G43.1 Z0
    G38.2 G91 Z-${settings.seekDistance} F${settings.seekFeedrate}
    G0 G91 Z5
    G38.2 G91 Z-5 F250
    G91 G0 Z5
    G90
    #<_ofs_idx> = [#5220 * 20 + 5203]
    #<_cur_wcs_z_ofs> = #[#<_ofs_idx>]
    #<_rc_trigger_mach_z> = [#5063 + #<_cur_wcs_z_ofs>]
    G43.1 Z[#<_rc_trigger_mach_z>]
    (Notify ncSender that toolLengthSet is now set)
    $#=_tool_offset
    G53 G91 G0 Z${settings.zSafe}
  `.trim();
}

// Helper: Tool unload routine
function createToolUnload(settings) {
  return `
    G53 G0 Z${settings.zSafe}
    (MSG, RCS:UNLOAD_MESSAGE)
    M0
    G53 G0 X${settings.pocket1.x} Y${settings.pocket1.y}
    G53 G0 Z${settings.zEngagement + settings.zSpinOff}
    G65P6
    M4 S${settings.unloadRpm}
    G53 G1 Z${settings.zEngagement} F${settings.engageFeedrate}
    G53 G1 Z${settings.zEngagement + settings.zRetreat} F${settings.engageFeedrate}
    G65P6
    M5
    M61 Q0
    G53 G0 Z${settings.zSafe}
  `.trim();
}

// Helper: Tool load routine
function createToolLoad(settings, toolNumber) {
  return `
    G53 G0 Z${settings.zSafe}
    (MSG, RCS:LOAD_MESSAGE)
    G4 P0.1
    M0
    G53 G0 X${settings.pocket1.x} Y${settings.pocket1.y}
    G53 G0 Z${settings.zEngagement + settings.zSpinOff}
    G65P6
    M3 S${settings.loadRpm}
    G53 G1 Z${settings.zEngagement} F${settings.engageFeedrate}
    G53 G1 Z${settings.zEngagement + settings.zRetreat} F${settings.engageFeedrate}
    G53 G1 Z${settings.zEngagement} F${settings.engageFeedrate}
    G53 G1 Z${settings.zEngagement + settings.zRetreat} F${settings.engageFeedrate}
    G53 G1 Z${settings.zEngagement} F${settings.engageFeedrate}
    G53 G1 Z${settings.zEngagement + settings.zRetreat} F${settings.engageFeedrate}
    G65P6
    M5
    M61 Q${toolNumber}
    G53 G0 Z${settings.zSafe}
  `.trim();
}

// Build unload tool section
function buildUnloadTool(settings, currentTool) {
  if (currentTool === 0) {
    return '';
  }
  return `
    (Unload current tool T${currentTool})
    ${createToolUnload(settings)}
  `.trim();
}

// Build load tool section
function buildLoadTool(settings, toolNumber, tlsRoutine) {
  if (toolNumber === 0) {
    return '';
  }
  return `
    (Load new tool T${toolNumber})
    ${createToolLoad(settings, toolNumber)}
    ${tlsRoutine}
  `.trim();
}

// Helper: Build tool change program
function buildToolChangeProgram(settings, currentTool, toolNumber) {
  const tlsRoutine = createToolLengthSetRoutine(settings);

  // Build sections
  const unloadSection = buildUnloadTool(settings, currentTool);
  const loadSection = buildLoadTool(settings, toolNumber, tlsRoutine);

  // Assemble complete program with return to units wrapper
  const gcode = `
    (Start of RapidChangeSolo Plugin Sequence)
    #<return_units> = [20 + #<_metric>]
    G21
    M5
    ${unloadSection}
    ${loadSection}
    G53 G0 Z${settings.zSafe}
    G[#<return_units>]
    G90
    (End of RapidChangeSolo Plugin Sequence)
    (MSG, TOOL CHANGE COMPLETE: T${toolNumber})
  `.trim();

  return formatGCode(gcode);
}

// Handle $TLS command
function handleTLSCommand(commands, settings, ctx) {
  const tlsIndex = commands.findIndex(cmd =>
    cmd.isOriginal && cmd.command.trim().toUpperCase() === '$TLS'
  );

  if (tlsIndex === -1) {
    return; // No $TLS command found
  }

  ctx.log('$TLS command detected, replacing with tool length setter routine');

  const tlsCommand = commands[tlsIndex];
  const toolLengthSetRoutine = createToolLengthSetRoutine(settings);
  const gcode = `
         #<return_units> = [20 + #<_metric>]
        G21
        ${toolLengthSetRoutine}
        G[#<return_units>]
        G90
        (MSG, TOOL CHANGE COMPLETE)
    `.trim();
  const tlsProgram = formatGCode(gcode);

  const expandedCommands = tlsProgram.map((line, index) => {
    if (index === 0) {
      // First command - show $TLS in UI
      return {
        command: line,
        displayCommand: tlsCommand.command.trim(),
        isOriginal: false
      };
    } else {
      // Rest of commands - hide in UI (silent)
      return {
        command: line,
        displayCommand: null,
        isOriginal: false,
        meta: { silent: true }
      };
    }
  });

  commands.splice(tlsIndex, 1, ...expandedCommands);
}

// Handle $POCKET1 command
function handlePocket1Command(commands, settings, ctx) {
  const pocket1Index = commands.findIndex(cmd =>
    cmd.isOriginal && cmd.command.trim().toUpperCase() === '$POCKET1'
  );

  if (pocket1Index === -1) {
    return; // No $POCKET1 command found
  }

  ctx.log('$POCKET1 command detected, moving to pocket location');

  const pocket1Command = commands[pocket1Index];
  const gcode = `
    G53 G21 G90 G0 Z${settings.zSafe}
    G53 G21 G90 G0 X${settings.pocket1.x} Y${settings.pocket1.y}
  `.trim();

  const pocket1Program = formatGCode(gcode);

  const expandedCommands = pocket1Program.map((line, index) => {
    if (index === 0) {
      // First command - show $POCKET1 in UI
      return {
        command: line,
        displayCommand: pocket1Command.command.trim(),
        isOriginal: false
      };
    } else {
      // Rest of commands - hide in UI (silent)
      return {
        command: line,
        displayCommand: null,
        isOriginal: false,
        meta: { silent: true }
      };
    }
  });

  commands.splice(pocket1Index, 1, ...expandedCommands);
}

// Show safety warning dialog
function showSafetyWarningDialog(ctx, title, message, continueLabel) {
  ctx.showModal(
    /* html */ `
      <style>
        .rcs-safety-container {
          background: var(--color-surface);
          border-radius: var(--radius-medium);
          padding: 32px;
          max-width: 500px;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
        }

        .rcs-safety-header {
          font-size: 1.5rem;
          font-weight: 600;
          color: var(--color-text-primary);
          margin-bottom: 24px;
          text-align: center;
        }

        .rcs-safety-dialog {
          display: flex;
          flex-direction: column;
          gap: 24px;
        }

        .rcs-safety-message {
          font-size: 1rem;
          line-height: 1.5;
          color: var(--color-text-primary);
          background: color-mix(in srgb, var(--color-warning) 15%, transparent);
          border: 2px solid var(--color-warning);
          border-radius: var(--radius-small);
          padding: 16px;
        }

        .rcs-safety-actions {
          display: flex;
          justify-content: center;
          gap: 16px;
        }

        .rcs-long-press-button {
          position: relative;
          padding: 12px 32px;
          border: none;
          border-radius: var(--radius-small);
          font-weight: 600;
          font-size: 1rem;
          cursor: pointer;
          transition: all 0.2s ease;
          overflow: hidden;
          min-width: 140px;
          user-select: none;
        }

        .rcs-long-press-button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .rcs-button-abort {
          background: var(--color-error, #dc2626);
          color: white;
        }

        .rcs-button-continue {
          background: var(--color-success, #16a34a);
          color: white;
        }

        .rcs-button-progress {
          position: absolute;
          bottom: 0;
          left: 0;
          height: 4px;
          background: rgba(255, 255, 255, 0.5);
          width: 0%;
          transition: width 0.05s linear;
        }

        .rcs-button-label {
          position: relative;
          z-index: 1;
        }
      </style>

      <div class="rcs-safety-container">
        <div class="rcs-safety-header">${title}</div>
        <div class="rcs-safety-dialog">
          <div class="rcs-safety-message">${message}</div>
          <div class="rcs-safety-actions">
            <button class="rcs-long-press-button rcs-button-abort" id="rcs-abort-btn">
              <span class="rcs-button-label">Abort</span>
              <div class="rcs-button-progress"></div>
            </button>
            <button class="rcs-long-press-button rcs-button-continue" id="rcs-continue-btn">
              <span class="rcs-button-label">${continueLabel}</span>
              <div class="rcs-button-progress"></div>
            </button>
          </div>
        </div>
      </div>

      <script>
        (function() {
          const LONG_PRESS_DURATION = 1000;
          let abortTimer = null;
          let continueTimer = null;
          let abortStartTime = 0;
          let continueStartTime = 0;
          let abortAnimFrame = null;
          let continueAnimFrame = null;

          const abortBtn = document.getElementById('rcs-abort-btn');
          const continueBtn = document.getElementById('rcs-continue-btn');
          const abortProgress = abortBtn.querySelector('.rcs-button-progress');
          const continueProgress = continueBtn.querySelector('.rcs-button-progress');

          const updateProgress = (startTime, progressEl) => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min((elapsed / LONG_PRESS_DURATION) * 100, 100);
            progressEl.style.width = progress + '%';
            return progress < 100;
          };

          const startAbortPress = () => {
            if (abortBtn.disabled) return;
            abortStartTime = Date.now();

            const animate = () => {
              if (updateProgress(abortStartTime, abortProgress)) {
                abortAnimFrame = requestAnimationFrame(animate);
              }
            };
            animate();

            abortTimer = setTimeout(() => {
              abortBtn.disabled = true;
              continueBtn.disabled = true;

              window.postMessage({
                type: 'send-command',
                command: '\\x18',
                displayCommand: '\\x18 (Soft Reset)'
              }, '*');

              window.postMessage({ type: 'close-modal' }, '*');
            }, LONG_PRESS_DURATION);
          };

          const stopAbortPress = () => {
            if (abortTimer) {
              clearTimeout(abortTimer);
              abortTimer = null;
            }
            if (abortAnimFrame) {
              cancelAnimationFrame(abortAnimFrame);
              abortAnimFrame = null;
            }
            abortProgress.style.width = '0%';
          };

          const startContinuePress = () => {
            if (continueBtn.disabled) return;
            continueStartTime = Date.now();

            const animate = () => {
              if (updateProgress(continueStartTime, continueProgress)) {
                continueAnimFrame = requestAnimationFrame(animate);
              }
            };
            animate();

            continueTimer = setTimeout(() => {
              abortBtn.disabled = true;
              continueBtn.disabled = true;

              window.postMessage({
                type: 'send-command',
                command: '~',
                displayCommand: '~ (Cycle Start)'
              }, '*');

              window.postMessage({ type: 'close-modal' }, '*');
            }, LONG_PRESS_DURATION);
          };

          const stopContinuePress = () => {
            if (continueTimer) {
              clearTimeout(continueTimer);
              continueTimer = null;
            }
            if (continueAnimFrame) {
              cancelAnimationFrame(continueAnimFrame);
              continueAnimFrame = null;
            }
            continueProgress.style.width = '0%';
          };

          abortBtn.addEventListener('mousedown', startAbortPress);
          abortBtn.addEventListener('mouseup', stopAbortPress);
          abortBtn.addEventListener('mouseleave', stopAbortPress);
          abortBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startAbortPress(); });
          abortBtn.addEventListener('touchend', (e) => { e.preventDefault(); stopAbortPress(); });
          abortBtn.addEventListener('touchcancel', stopAbortPress);

          continueBtn.addEventListener('mousedown', startContinuePress);
          continueBtn.addEventListener('mouseup', stopContinuePress);
          continueBtn.addEventListener('mouseleave', stopContinuePress);
          continueBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startContinuePress(); });
          continueBtn.addEventListener('touchend', (e) => { e.preventDefault(); stopContinuePress(); });
          continueBtn.addEventListener('touchcancel', stopContinuePress);
        })();
      </script>
    `,
    { closable: false }
  );
}

// Handle M6 tool change command
function handleM6Command(commands, context, settings, ctx) {
  // Find original M6 command
  const m6Index = commands.findIndex(cmd => {
    if (!cmd.isOriginal) return false;
    const parsed = ctx.utils.parseM6Command(cmd.command);
    return parsed?.matched && parsed.toolNumber !== null;
  });

  if (m6Index === -1) {
    return; // No M6 found
  }

  const m6Command = commands[m6Index];
  const parsed = ctx.utils.parseM6Command(m6Command.command);

  if (!parsed?.matched || parsed.toolNumber === null) {
    return;
  }

  const toolNumber = parsed.toolNumber;
  const location = context.lineNumber !== undefined ? `at line ${context.lineNumber}` : `from ${context.sourceId}`;
  const currentTool = context.machineState?.tool ?? 0;

  ctx.log(`M6 detected with tool T${toolNumber} ${location}, current tool: T${currentTool}, executing tool change program`);

  const toolChangeProgram = buildToolChangeProgram(settings, currentTool, toolNumber);

  // Replace M6 command with expanded program
  const expandedCommands = toolChangeProgram.map((line, index) => {
    if (index === 0) {
      // First command - show original M6 in UI
      return {
        command: line,
        displayCommand: m6Command.command.trim(),
        isOriginal: false
      };
    } else {
      // Rest of commands - hide in UI (silent)
      return {
        command: line,
        displayCommand: null,
        isOriginal: false,
        meta: { silent: true }
      };
    }
  });

  commands.splice(m6Index, 1, ...expandedCommands);
}

export async function onLoad(ctx) {
  ctx.log('Rapid Change Solo plugin loaded');

  // Get current plugin settings and app settings
  const pluginSettings = ctx.getSettings() || {};
  const appSettings = ctx.getAppSettings() || {};

  // Check if plugin has been configured (has required settings)
  const isConfigured = !!(pluginSettings.pocket1);

  // Set tool.source to indicate this plugin controls the tool settings
  // Only enable manual and TLS tools if plugin is configured
  // Always set count to 0 for manual tool changer
  await new Promise(resolve => setTimeout(resolve, 100));

  try {
    const response = await fetch(`http://localhost:${resolveServerPort(pluginSettings, appSettings)}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: {
          count: 0,
          source: 'com.ncsender.rapidchangesolo',
          manual: isConfigured,
          tls: isConfigured
        }
      })
    });

    if (response.ok) {
      ctx.log(`Tool settings synchronized: count=0, manual=${isConfigured}, tls=${isConfigured} (source: com.ncsender.rapidchangesolo)`);
    } else {
      ctx.log(`Failed to sync tool settings: ${response.status}`);
    }
  } catch (error) {
    ctx.log('Failed to sync tool settings on plugin load:', error);
  }

  const MESSAGE_MAP = {
    'RCS:UNLOAD_MESSAGE': {
      title: 'Unloading',
      message: 'Ensure the pocket is empty and keep hands clear. The spindle will descend into the pocket during the unload process. <strong>PRESS</strong> and <strong>HOLD</strong> <em>"Abort"</em> or <em>"Unload"</em> to proceed.',
      continueLabel: 'Unload'
    },
    'RCS:LOAD_MESSAGE': {
      title: 'Loading',
      message: 'Confirm the correct tool is placed securely in the pocket and keep hands clear. The spindle will descend to pick up the tool during the load process. <strong>PRESS</strong> and <strong>HOLD</strong> <em>"Abort"</em> or <em>"Load"</em> to proceed.',
      continueLabel: 'Load'
    }
  };

  ctx.registerEventHandler('ws:cnc-data', async (data) => {
    if (typeof data === 'string') {
      const upperData = data.toUpperCase();
      if (upperData.includes('[MSG') && upperData.includes('RCS:')) {
        for (const [code, config] of Object.entries(MESSAGE_MAP)) {
          if (upperData.includes(code)) {
            showSafetyWarningDialog(ctx, config.title, config.message, config.continueLabel);
            break;
          }
        }
      }
    }
  });

  // Register onBeforeCommand event handler for M6 interception
  ctx.registerEventHandler('onBeforeCommand', async (commands, context) => {
    const rawSettings = ctx.getSettings() || {};

    // Skip command handling if plugin is not configured
    if (!rawSettings.pocket1) {
      return commands;
    }

    const settings = buildInitialConfig(rawSettings);

    // Handle $TLS command
    handleTLSCommand(commands, settings, ctx);

    // Handle $POCKET1 command
    handlePocket1Command(commands, settings, ctx);

    // Handle M6 tool change command
    handleM6Command(commands, context, settings, ctx);

    return commands;
  });

  ctx.registerEventHandler('message', async (data) => {
    if (!data) {
      return;
    }

    if (data.action === 'save') {
      const payload = data.payload || {};
      const sanitized = buildInitialConfig(payload);
      const existing = ctx.getSettings() || {};
      const appSettings = ctx.getAppSettings() || {};
      const resolvedPort = resolveServerPort(existing, appSettings);

      ctx.setSettings({
        ...existing,
        ...sanitized,
        port: resolvedPort
      });

      ctx.log('Rapid Change Solo settings saved');
    }
  });

  ctx.registerToolMenu('RapidChangeSolo', async () => {
    ctx.log('RapidChangeSolo tool opened');

    const storedSettings = ctx.getSettings() || {};
    const appSettings = ctx.getAppSettings() || {};
    const serverPort = resolveServerPort(storedSettings, appSettings);
    const initialConfig = buildInitialConfig(storedSettings);
    const initialConfigJson = JSON.stringify(initialConfig)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e');

    ctx.showDialog(
      'RapidChange Solo',
      /* html */ `
      <style>
        .rcs-dialog-wrapper {
          display: grid;
          grid-template-rows: auto 1fr auto;
          overflow: hidden;
          width: 500px;
        }

        .rcs-header {
          padding: 10px 30px;
        }

        .rcs-content {
          overflow-y: auto;
          padding: 30px;
          padding-top: 20px;
        }

        .rcs-container {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .rcs-axis-card {
          background: color-mix(in srgb, var(--color-surface) 40%, var(--color-surface-muted) 60%);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-small);
          padding: 12px 16px;
        }

        .rcs-axis-title {
          font-size: 0.85rem;
          font-weight: 600;
          color: var(--color-text-secondary);
          margin-bottom: 8px;
          text-align: center;
        }

        .rcs-axis-values {
          display: flex;
          justify-content: space-around;
          gap: 16px;
        }

        .rcs-axis-item {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
        }

        .rcs-axis-label {
          font-size: 0.75rem;
          font-weight: 700;
          color: var(--color-text-secondary);
          text-transform: uppercase;
        }

        .rcs-axis-value {
          font-family: 'JetBrains Mono', monospace;
          font-size: 1rem;
          font-weight: 600;
          color: var(--color-accent);
        }

        .rcs-form-row {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 12px;
        }

        .rcs-form-row-wide {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 16px;
        }

        .rcs-form-group {
          display: flex;
          flex-direction: column;
          gap: 8px;
          align-items: center;
        }

        .rcs-form-group-horizontal {
          display: flex;
          flex-direction: row;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
        }

        .rcs-form-group-horizontal .rcs-form-label {
          white-space: nowrap;
          min-width: fit-content;
        }

        .rcs-form-label {
          font-size: 0.9rem;
          font-weight: 600;
          color: var(--color-text-primary);
        }

        .rcs-input {
          padding: 8px 12px;
          border: 1px solid var(--color-border);
          border-radius: var(--radius-small);
          background: var(--color-surface);
          color: var(--color-text-primary);
          font-size: 0.9rem;
          text-align: right;
          width: 100%;
          max-width: 120px;
        }

        .rcs-input:focus {
          outline: none;
          border-color: var(--color-accent);
        }

        .rcs-control-group {
          background: color-mix(in srgb, var(--color-surface) 40%, var(--color-surface-muted) 60%);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-small);
          padding: 12px 16px;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .rcs-control-group nc-step-control {
          width: 100%;
          display: flex;
          justify-content: center;
          transform: scale(0.95);
        }

        .rcs-control-group nc-jog-control {
          width: 100%;
          display: flex;
          justify-content: center;
        }

        .rcs-slider-toggle {
          position: relative;
          display: flex;
          background: var(--color-surface);
          border-radius: 999px;
          padding: 4px;
          border: 1px solid var(--color-border);
          width: 100px;
        }

        .rcs-slider-option {
          flex: 1;
          padding: 6px 12px;
          font-size: 0.85rem;
          font-weight: 500;
          color: var(--color-text-secondary);
          background: transparent;
          cursor: pointer;
          transition: color 0.2s ease;
          text-align: center;
          z-index: 2;
          position: relative;
          user-select: none;
        }

        .rcs-slider-option.active {
          color: #fff;
        }

        .rcs-slider-indicator {
          position: absolute;
          height: calc(100% - 8px);
          background: var(--gradient-accent);
          border-radius: 999px;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          z-index: 1;
          top: 4px;
        }

        .rcs-pocket-group {
          background: color-mix(in srgb, var(--color-surface) 40%, var(--color-surface-muted) 60%);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-small);
          padding: 16px;
        }

        .rcs-pocket-header {
          display: flex;
          justify-content: center;
          align-items: center;
          gap: 12px;
          margin-bottom: 16px;
        }

        .rcs-pocket-title {
          font-size: 0.95rem;
          font-weight: 600;
          color: var(--color-text-primary);
        }

        .rcs-button {
          padding: 4px 16px;
          border: none;
          border-radius: var(--radius-small);
          font-weight: 500;
          font-size: 0.8rem;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .rcs-button-grab {
          background: var(--gradient-accent);
          color: white;
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .rcs-button-grab:hover {
          opacity: 0.9;
        }

        .rcs-button-grab:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .rcs-footer {
          display: flex;
          justify-content: center;
          gap: 12px;
          padding: 20px 30px;
          border-top: 1px solid var(--color-border);
        }

        .rcs-button-secondary {
          background: var(--color-surface-muted);
          color: var(--color-text-primary);
        }

        .rcs-button-secondary:hover {
          background: var(--color-surface);
        }

        .rcs-button-primary {
          background: var(--gradient-accent);
          color: white;
        }

        .rcs-button-primary:hover {
          opacity: 0.9;
        }

        @keyframes rcs-glow {
          0%, 100% { box-shadow: 0 0 5px var(--color-accent); }
          50% { box-shadow: 0 0 20px var(--color-accent); }
        }

        .rcs-button-saved {
          animation: rcs-glow 0.5s ease-in-out;
        }

        .rcs-button-busy {
          opacity: 0.6;
          cursor: wait;
        }
      </style>

      <div class="rcs-dialog-wrapper">
        <div class="rcs-content">
          <div class="rcs-container">
            <!-- Machine Coordinates Display -->
            <div class="rcs-axis-card">
              <div class="rcs-axis-title">Machine Coordinates</div>
              <div class="rcs-axis-values">
                <div class="rcs-axis-item">
                  <span class="rcs-axis-label">X</span>
                  <span class="rcs-axis-value" id="rcs-axis-x">0.000</span>
                </div>
                <div class="rcs-axis-item">
                  <span class="rcs-axis-label">Y</span>
                  <span class="rcs-axis-value" id="rcs-axis-y">0.000</span>
                </div>
                <div class="rcs-axis-item">
                  <span class="rcs-axis-label">Z</span>
                  <span class="rcs-axis-value" id="rcs-axis-z">0.000</span>
                </div>
              </div>
            </div>

            <!-- Controls Group -->
            <div class="rcs-control-group">
              <nc-step-control></nc-step-control>
              <nc-jog-control></nc-jog-control>
            </div>

            <!-- Location -->
            <div class="rcs-pocket-group">
              <div class="rcs-pocket-header">
                <span class="rcs-pocket-title">Location</span>
                <button type="button" class="rcs-button rcs-button-grab" id="rcs-pocket1-grab">Grab</button>
              </div>

              <div class="rcs-form-row">
                <div class="rcs-form-group">
                  <label class="rcs-form-label">X</label>
                  <input type="number" class="rcs-input" id="rcs-pocket1-x" value="0" step="0.001">
                </div>
                <div class="rcs-form-group">
                  <label class="rcs-form-label">Y</label>
                  <input type="number" class="rcs-input" id="rcs-pocket1-y" value="0" step="0.001">
                </div>
                <div class="rcs-form-group">
                  <label class="rcs-form-label">Z</label>
                  <input type="number" class="rcs-input" id="rcs-zengagement" value="-50" step="0.001">
                </div>
              </div>

              <div class="rcs-form-row-wide" style="margin-top: 16px;">
                <div class="rcs-form-group-horizontal">
                  <label class="rcs-form-label">Orientation</label>
                  <div class="rcs-slider-toggle" id="rcs-orientation-toggle">
                    <span class="rcs-slider-option active" data-value="Y">Y</span>
                    <span class="rcs-slider-option" data-value="X">X</span>
                    <div class="rcs-slider-indicator"></div>
                  </div>
                </div>

                <div class="rcs-form-group-horizontal">
                  <label class="rcs-form-label">Direction</label>
                  <div class="rcs-slider-toggle" id="rcs-direction-toggle">
                    <span class="rcs-slider-option active" data-value="Negative">-</span>
                    <span class="rcs-slider-option" data-value="Positive">+</span>
                    <div class="rcs-slider-indicator"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="rcs-footer">
          <button type="button" class="rcs-button rcs-button-secondary" id="rcs-close-btn">Close</button>
          <button type="button" class="rcs-button rcs-button-primary" id="rcs-save-btn">Save</button>
        </div>
      </div>

      <script>
        (function() {
          const BASE_URL = '';
          const POCKET_PREFIX = 'pocket1';

          const initialConfig = JSON.parse('${initialConfigJson}');

          const getInput = (id) => document.getElementById(id);
          const formatCoordinate = (value) => (Number.isFinite(value) ? value.toFixed(3) : '0.000');

          const parseCoordinateString = (raw) => {
            if (typeof raw === 'string' && raw.length > 0) {
              const parts = raw.split(',').map((part) => Number.parseFloat(part.trim()));
              if (parts.length >= 2 && parts.every(Number.isFinite)) {
                return { x: parts[0], y: parts[1], z: parts[2] };
              }
            }
            if (Array.isArray(raw) && raw.length >= 2) {
              const [x, y, z] = raw;
              if ([x, y].every(Number.isFinite)) {
                return { x, y, z };
              }
            }
            if (raw && typeof raw === 'object') {
              const { x, y, z } = raw;
              if ([x, y].every(Number.isFinite)) {
                return { x, y, z };
              }
            }
            return null;
          };

          const extractCoordinatesFromPayload = (payload) => {
            if (!payload || typeof payload !== 'object') {
              return null;
            }

            const nestedKeys = ['machineState', 'lastStatus', 'statusReport'];
            for (let i = 0; i < nestedKeys.length; i += 1) {
              const key = nestedKeys[i];
              if (payload[key] && typeof payload[key] === 'object') {
                const nestedCoords = extractCoordinatesFromPayload(payload[key]);
                if (nestedCoords) {
                  return nestedCoords;
                }
              }
            }

            const candidates = [
              payload.machineCoords,
              payload.MPos,
              payload.MPOS,
              payload.mpos,
              payload.machinePosition
            ];

            for (let i = 0; i < candidates.length; i += 1) {
              const coords = parseCoordinateString(candidates[i]);
              if (coords) {
                return coords;
              }
            }

            return null;
          };

          const initSliderToggle = (toggleId) => {
            const toggle = document.getElementById(toggleId);
            const options = toggle.querySelectorAll('.rcs-slider-option');
            const indicator = toggle.querySelector('.rcs-slider-indicator');

            const updateIndicator = (activeOption) => {
              indicator.style.left = (activeOption.offsetLeft) + 'px';
              indicator.style.width = activeOption.getBoundingClientRect().width + 'px';
            };

            options.forEach((option) => {
              option.addEventListener('click', () => {
                options.forEach((opt) => opt.classList.remove('active'));
                option.classList.add('active');
                updateIndicator(option);
              });
            });

            const activeOption = toggle.querySelector('.rcs-slider-option.active');
            if (activeOption) {
              setTimeout(() => updateIndicator(activeOption), 0);
            }
          };

          const getSliderValue = (toggleId) => {
            const toggle = document.getElementById(toggleId);
            if (!toggle) return null;
            const activeOption = toggle.querySelector('.rcs-slider-option.active');
            return activeOption ? activeOption.getAttribute('data-value') : null;
          };

          const setSliderValue = (toggleId, value) => {
            const toggle = document.getElementById(toggleId);
            if (!toggle || !value) return;

            const options = toggle.querySelectorAll('.rcs-slider-option');
            const indicator = toggle.querySelector('.rcs-slider-indicator');

            options.forEach((option) => {
              if (option.getAttribute('data-value') === value) {
                options.forEach((opt) => opt.classList.remove('active'));
                option.classList.add('active');

                setTimeout(() => {
                  indicator.style.left = (option.offsetLeft) + 'px';
                  indicator.style.width = option.getBoundingClientRect().width + 'px';
                }, 0);
              }
            });
          };

          const applyInitialSettings = () => {
            if (initialConfig.pocket1) {
              getInput('rcs-pocket1-x').value = initialConfig.pocket1.x || 0;
              getInput('rcs-pocket1-y').value = initialConfig.pocket1.y || 0;
            }

            getInput('rcs-zengagement').value = initialConfig.zEngagement || -50;

            setSliderValue('rcs-orientation-toggle', initialConfig.orientation || 'Y');
            setSliderValue('rcs-direction-toggle', initialConfig.direction || 'Negative');
          };

          const grabCoordinates = async (prefix) => {
            try {
              const response = await fetch(BASE_URL + '/api/server-state');
              if (!response.ok) {
                throw new Error('Failed to fetch server state: ' + response.status);
              }

              const state = await response.json();
              const coords = extractCoordinatesFromPayload(state);

              if (!coords) {
                throw new Error('No coordinates available in server state');
              }

              getInput(\`rcs-\${prefix}-x\`).value = (coords.x || 0).toFixed(3);
              getInput(\`rcs-\${prefix}-y\`).value = (coords.y || 0).toFixed(3);

              // Grab Z coordinate with -5 offset for zEngagement
              const zEngagement = (coords.z || 0) - 5;
              getInput('rcs-zengagement').value = zEngagement.toFixed(3);

            } catch (error) {
              console.error('[RapidChangeSolo] Failed to grab coordinates:', error);
            }
          };

          const registerButton = (prefix, buttonId) => {
            const button = getInput(buttonId);
            if (button) {
              button.addEventListener('click', async function() {
                if (button.disabled) return;
                button.disabled = true;

                try {
                  await grabCoordinates(prefix);
                } finally {
                  setTimeout(() => { button.disabled = false; }, 500);
                }
              });
            }
          };

          const gatherFormData = () => {
            return {
              pocket1: {
                x: parseFloat(getInput('rcs-pocket1-x').value) || 0,
                y: parseFloat(getInput('rcs-pocket1-y').value) || 0
              },
              zEngagement: parseFloat(getInput('rcs-zengagement').value) || -50,
              orientation: getSliderValue('rcs-orientation-toggle'),
              direction: getSliderValue('rcs-direction-toggle')
            };
          };

          const closeButton = getInput('rcs-close-btn');
          if (closeButton) {
            closeButton.addEventListener('click', function() {
              window.postMessage({ type: 'close-plugin-dialog' }, '*');
            });
          };

          const saveButton = getInput('rcs-save-btn');
          if (saveButton) {
            saveButton.addEventListener('click', async function() {
              if (saveButton.disabled) return;

              saveButton.disabled = true;
              saveButton.classList.add('rcs-button-busy');

              const payload = gatherFormData();

              try {
                const pluginResponse = await fetch(BASE_URL + '/api/plugins/com.ncsender.rapidchangesolo/settings', {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(payload)
                });

                if (!pluginResponse.ok) {
                  throw new Error('Failed to save plugin settings: ' + pluginResponse.status);
                }

                // Update tool settings to enable manual and TLS
                const settingsResponse = await fetch(BASE_URL + '/api/settings', {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    tool: {
                      count: 0,
                      source: 'com.ncsender.rapidchangesolo',
                      manual: true,
                      tls: true
                    }
                  })
                });

                if (!settingsResponse.ok) {
                  throw new Error('Failed to update tool settings: ' + settingsResponse.status);
                }

                saveButton.textContent = 'Saved';
                saveButton.classList.add('rcs-button-saved');
                saveButton.classList.remove('rcs-button-busy');
                saveButton.disabled = false;

                setTimeout(function() {
                  saveButton.textContent = 'Save';
                  saveButton.classList.remove('rcs-button-saved');
                }, 2000);
              } catch (error) {
                console.error('[RapidChangeSolo] Failed to save settings:', error);
                saveButton.disabled = false;
                saveButton.classList.remove('rcs-button-busy');
              }
            });
          }

          const updateAxisDisplay = (coords) => {
            if (!coords) return;

            const axisX = document.getElementById('rcs-axis-x');
            const axisY = document.getElementById('rcs-axis-y');
            const axisZ = document.getElementById('rcs-axis-z');

            if (axisX && coords.x !== undefined) axisX.textContent = formatCoordinate(coords.x);
            if (axisY && coords.y !== undefined) axisY.textContent = formatCoordinate(coords.y);
            if (axisZ && coords.z !== undefined) axisZ.textContent = formatCoordinate(coords.z);
          };

          const handleServerStateUpdate = (event) => {
            if (!event.data || event.data.type !== 'server-state-update') return;

            const coords = extractCoordinatesFromPayload(event.data.state);
            if (coords) {
              updateAxisDisplay(coords);
            }
          };

          const fetchInitialCoordinates = async () => {
            try {
              const response = await fetch(BASE_URL + '/api/server-state');
              if (!response.ok) return;

              const state = await response.json();
              const coords = extractCoordinatesFromPayload(state);

              if (coords) {
                updateAxisDisplay(coords);
              }
            } catch (error) {
              console.error('[RapidChangeSolo] Failed to fetch initial coordinates:', error);
            }
          };

          window.addEventListener('message', handleServerStateUpdate);

          applyInitialSettings();
          registerButton(POCKET_PREFIX, 'rcs-pocket1-grab');

          initSliderToggle('rcs-orientation-toggle');
          initSliderToggle('rcs-direction-toggle');

          fetchInitialCoordinates();
        })();
      </script>
    `,
      { size: 'large' }
    );
  }, {
    icon: 'logo.png'
  });
}

export async function onUnload(ctx) {
  ctx.log('Rapid Change Solo plugin unloading');

  // Reset tool settings to give control back to Settings > General
  const pluginSettings = ctx.getSettings() || {};
  const appSettings = ctx.getAppSettings() || {};

  try {
    const response = await fetch(`http://localhost:${resolveServerPort(pluginSettings, appSettings)}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: {
          source: null,
          count: 0,
          manual: false,
          tls: false
        }
      })
    });

    if (response.ok) {
      ctx.log('Tool settings reset: count=0, manual=false, tls=false, source=null');
    } else {
      ctx.log(`Failed to reset tool settings: ${response.status}`);
    }
  } catch (error) {
    ctx.log('Failed to reset tool settings on plugin unload:', error);
  }
}
