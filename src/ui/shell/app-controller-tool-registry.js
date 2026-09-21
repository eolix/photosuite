/**
 * The tool registry: the catalog of every tool the controller can activate.
 *
 * `createToolRegistry()` builds the data structure AppController stores as
 * `this.toolRegistry`; `initToolRegistryMap()` indexes it. Its pieces:
 *   - `toolbarGroups` — the visible toolbar strip, an array of groups where each
 *     group is a set of tool variants sharing one slot (and one shortcut key);
 *     `"---"` marks a separator.
 *   - `toolbarShortcutKeys` — one key per toolbar group, index-aligned to it.
 *   - `auxiliaryToolEntries` — tools reachable by command rather than the strip
 *     (free transform, warp, content-aware scale, puppet warp).
 *   - `filterTrackerEntries` — non-tool listeners (history, layer effects, smart
 *     filters) that route through the same entry table.
 *   - `entriesById` — every entry indexed by its tool id; the map the controller
 *     looks tools up in at runtime.
 *   - `modifierToolOverrides` — the hold-a-key temporary tools (space to pan,
 *     etc.), consumed by app-controller-tools.
 *   - `selectedVariantByGroup` / `savedActiveToolId` / `temporaryToolId` /
 *     `pointerDownToolId` — mutable selection and active-tool state.
 *
 * Each entry is `{ tool, optionPanelClass }` (see `toolEntry`); the option panel
 * is instantiated lazily when the tool is first activated.
 */
import { KeyboardHandler } from "../../core/keyboard-handler.js";
import { ToolId } from "../../document/model/tool-base.js";
import { TrackerRegistry } from "../../features/trackers/tracker-registry.js";
import {
  CropTool,
  PerspectiveCropTool
} from "../../document/tools/crop-tools.js";
import {
  LassoTool,
  MagneticLassoTool,
  PolygonLassoTool
} from "../../document/tools/lasso-tools.js";
import { MoveTool } from "../../document/tools/move-tools.js";
import {
  BackgroundEraserTool,
  BrushTool,
  EraserTool,
  GradientTool,
  PaintBucketTool,
  PencilTool
} from "../../document/tools/paint-tools.js";
import {
  DirectSelectTool,
  PathSelectTool,
  PenTool
} from "../../document/tools/pen-path-tools.js";
import {
  BlurTool,
  BurnTool,
  CloneStampTool,
  ColorReplacementTool,
  ContentAwareMoveTool,
  DodgeTool,
  HealBrushTool,
  PatchToolBase,
  RedEyeTool,
  SharpenTool,
  SmudgeTool,
  SpongeTool,
  SpotHealTool
} from "../../document/tools/retouch-tools.js";
import {
  EllipseSelectTool,
  MagicWandTool,
  QuickSelectTool,
  RectSelectTool
} from "../../document/tools/selection-tools.js";
import {
  CustomShapeTool,
  EllipseShapeTool,
  FreePenTool,
  LineShapeTool,
  ParametricShapeTool,
  RectShapeTool
} from "../../document/tools/shape-tools.js";
import { TextTool } from "../../document/tools/text-tools.js";
import {
  EyedropperTool,
  HandTool,
  RotateViewTool,
  RulerTool,
  ZoomTool
} from "../../document/tools/view-tools.js";
import { PuppetWarpTool } from "../../document/transform/puppet-warp-tool.js";
import {
  SliceSelectTool,
  SliceTool
} from "../../document/transform/slice-tools.js";
import {
  ContentAwareScaleTool,
  FreeTransformTool,
  ObjectSelectTool,
  WarpTool
} from "../../document/transform/transform-tools.js";
import {
  MoveToolOption,
  ColorFillOptionB,
  ColorFillOption,
  FillOptionA,
  FillOptionB,
  FillOptionC,
  FillColorOption,
  CropToolOption,
  SampleSizeOption,
  TransformOptionBar,
  SmudgeBrushOption,
  PatternStampOption,
  PatchOption,
  SetOpOption,
  BasicBrushOption,
  PaintBrushOption,
  BlurBrushOption,
  HealBrushOption,
  CloneStampOption,
  AirbrushOption,
  ContentFillOption,
  AlignOption,
  PatchBrushOption,
  StrenBrushOption,
  SharpenBrushOption,
  MixBrushOptionA,
  SpongeBrushOption,
  DodgeBrushOption,
  MixBrushOptionB,
  GradientStrokeOption,
  EmptyOption,
  AngleOption,
  ZoomOption
} from "../tool-options/brush-fill-tool-options.js";
import {
  CompactCropOption,
  FillOptionD,
  QuickSelectOption,
  EmptyOptionPanel,
  LayerOrderOption,
  LineworkOption,
  LassoOption,
  PathSelectOption,
  DirectSelectShapeOption,
  RectShapeOption,
  SelectionModeOption,
  LineShapeOption,
  PolygonShapeOption,
  CustomShapeOption,
  TextLeadingOption,
  TextTrackingOption,
  TextBaselineOption,
  WarpOption
} from "../tool-options/shape-text-tool-options.js";

/**
 * Fresh tool registry for an AppController instance.
 * @returns {object}
 */
export function createToolRegistry() {
  return {
    modifierToolOverrides: buildModifierToolOverrides(),
    toolbarGroups: buildToolbarGroups(),
    selectedVariantByGroup: [],
    toolbarShortcutKeys: buildToolbarShortcutKeys(),
    auxiliaryToolEntries: buildAuxiliaryToolEntries(),
    filterTrackerEntries: buildFilterTrackerEntries(),
    entriesById: {},
    savedActiveToolId: null,
    temporaryToolId: null,
    pointerDownToolId: null
  }
}

/**
 * Index toolbar / auxiliary / tracker entries into entriesById and set
 * group/variant indices plus default selectedVariantByGroup.
 * @param {object} toolRegistry
 */
export function initToolRegistryMap(toolRegistry) {
  indexToolbarGroups(toolRegistry);
  indexNamedEntries(toolRegistry, toolRegistry.auxiliaryToolEntries);
  indexNamedEntries(toolRegistry, toolRegistry.filterTrackerEntries);
}

export {
  buildModifierToolOverrides,
  buildToolbarShortcutKeys,
  toolEntry
};

// ---------------------------------------------------------------------------
// Entry helpers
// ---------------------------------------------------------------------------

/**
 * One registry entry: a tool instance paired with the option-panel class shown
 * in the confirm bar while that tool is active. `optionPanelClass` may be null.
 * @param {*} tool
 * @param {Function|null} optionPanelClass
 */
function toolEntry(tool, optionPanelClass) {
  return { tool, optionPanelClass }
}

function indexToolbarGroups(toolRegistry) {
  for (let groupIdx = 0; groupIdx < toolRegistry.toolbarGroups.length; groupIdx++) {
    const toolbarGroup = toolRegistry.toolbarGroups[groupIdx];
    if (toolbarGroup == "---") continue;
    for (let variantIdx = 0; variantIdx < toolbarGroup.length; variantIdx++) {
      const entry = toolbarGroup[variantIdx];
      toolRegistry.entriesById[entry.tool.id] = entry;
      entry.toolbarGroupIndex = groupIdx;
      entry.variantIndexInGroup = variantIdx
    }
    toolRegistry.selectedVariantByGroup[groupIdx] = 0
  }
}

function indexNamedEntries(toolRegistry, entries) {
  for (let entryIdx = 0; entryIdx < entries.length; entryIdx++) {
    toolRegistry.entriesById[entries[entryIdx].tool.id] = entries[entryIdx]
  }
}

// ---------------------------------------------------------------------------
// Modifier temporary-tool overrides
// ---------------------------------------------------------------------------

// Temporary tools that engage while modifier keys are held. Each override names
// the tool to switch to, the keys that must all be down, whether it engages even
// when the base tool is inactive, and an optional list of base tools it applies
// to. app-controller-tools resolves the first matching override each frame.
function buildModifierToolOverrides() {
  return [
    {
      documentModelType: ToolId.TOOL_ZOOM,
      activateWhileToolInactive: false,
      requiredModifierKeys: [KeyboardHandler.CtrlOrAlt, KeyboardHandler.Space]
    },
    {
      documentModelType: ToolId.TOOL_HAND,
      activateWhileToolInactive: false,
      requiredModifierKeys: [KeyboardHandler.Space]
    },
    {
      documentModelType: ToolId.TOOL_SLICE,
      activateWhileToolInactive: true,
      requiredModifierKeys: [KeyboardHandler.Ctrl],
      allowedBaseToolIds: [ToolId.TOOL_SLICE_SELECT]
    },
    {
      documentModelType: ToolId.TOOL_SLICE_SELECT,
      activateWhileToolInactive: true,
      requiredModifierKeys: [KeyboardHandler.Ctrl],
      allowedBaseToolIds: [ToolId.TOOL_SLICE]
    },
    {
      documentModelType: ToolId.TOOL_DIRECT_SELECT,
      activateWhileToolInactive: true,
      requiredModifierKeys: [KeyboardHandler.Ctrl],
      allowedBaseToolIds: [
        ToolId.TOOL_PATH_SELECT,
        ToolId.TOOL_PEN,
        ToolId.TOOL_FREE_PEN
      ]
    },
    {
      documentModelType: ToolId.TOOL_PATH_SELECT,
      activateWhileToolInactive: true,
      requiredModifierKeys: [KeyboardHandler.Ctrl],
      allowedBaseToolIds: [
        ToolId.TOOL_DIRECT_SELECT,
        ToolId.TOOL_RECT_SHAPE,
        ToolId.TOOL_ELLIPSE_SHAPE,
        ToolId.TOOL_LINE_SHAPE,
        ToolId.TOOL_PARAMETRIC_SHAPE,
        ToolId.TOOL_CUSTOM_SHAPE
      ]
    },
    {
      documentModelType: ToolId.TOOL_MOVE,
      activateWhileToolInactive: true,
      requiredModifierKeys: [KeyboardHandler.Ctrl]
    }
  ]
}

// ---------------------------------------------------------------------------
// Toolbar strip (one shortcut key per group; see buildToolbarShortcutKeys)
// ---------------------------------------------------------------------------

function buildToolbarGroups() {
  return [
    [toolEntry(new MoveTool(), MoveToolOption)],
    [
      toolEntry(new RectSelectTool(), ColorFillOptionB),
      toolEntry(new EllipseSelectTool(), ColorFillOption)
    ],
    [
      toolEntry(new LassoTool(), FillOptionA),
      toolEntry(new PolygonLassoTool(), FillOptionB),
      toolEntry(new MagneticLassoTool(), FillOptionC)
    ],
    [
      toolEntry(new ObjectSelectTool(), FillOptionD),
      toolEntry(new QuickSelectTool(), QuickSelectOption),
      toolEntry(new MagicWandTool(), FillColorOption)
    ],
    [
      toolEntry(new CropTool(), CropToolOption),
      toolEntry(new PerspectiveCropTool(), CompactCropOption),
      toolEntry(new SliceTool(), EmptyOptionPanel),
      toolEntry(new SliceSelectTool(), LayerOrderOption)
    ],
    [
      toolEntry(new EyedropperTool(), SampleSizeOption),
      toolEntry(new RulerTool(), TransformOptionBar)
    ],
    [
      toolEntry(new SpotHealTool(), SmudgeBrushOption),
      toolEntry(new HealBrushTool(), PatternStampOption),
      toolEntry(new PatchToolBase(), PatchOption),
      toolEntry(new ContentAwareMoveTool(), SetOpOption),
      toolEntry(new RedEyeTool(), BasicBrushOption)
    ],
    [
      toolEntry(new BrushTool(), PaintBrushOption),
      toolEntry(new PencilTool(), BlurBrushOption),
      toolEntry(new ColorReplacementTool(), HealBrushOption)
    ],
    [toolEntry(new CloneStampTool(), CloneStampOption)],
    [
      toolEntry(new EraserTool(), AirbrushOption),
      toolEntry(new BackgroundEraserTool(), ContentFillOption)
    ],
    [
      toolEntry(new GradientTool(), AlignOption),
      toolEntry(new PaintBucketTool(), PatchBrushOption)
    ],
    [
      toolEntry(new BlurTool(), StrenBrushOption),
      toolEntry(new SharpenTool(), SharpenBrushOption),
      toolEntry(new SmudgeTool(), MixBrushOptionA)
    ],
    [
      toolEntry(new DodgeTool(), SpongeBrushOption),
      toolEntry(new BurnTool(), DodgeBrushOption),
      toolEntry(new SpongeTool(), MixBrushOptionB)
    ],
    [
      toolEntry(new PenTool(), LineworkOption),
      toolEntry(new FreePenTool(), LassoOption)
    ],
    [toolEntry(new TextTool(), GradientStrokeOption)],
    [
      toolEntry(new PathSelectTool(), PathSelectOption),
      toolEntry(new DirectSelectTool(), DirectSelectShapeOption)
    ],
    [
      toolEntry(new RectShapeTool(), RectShapeOption),
      toolEntry(new EllipseShapeTool(), SelectionModeOption),
      toolEntry(new LineShapeTool(), LineShapeOption),
      toolEntry(new ParametricShapeTool(), PolygonShapeOption),
      toolEntry(new CustomShapeTool(), CustomShapeOption)
    ],
    [
      toolEntry(new HandTool(), EmptyOption),
      toolEntry(new RotateViewTool(), AngleOption)
    ],
    [toolEntry(new ZoomTool(), ZoomOption)]
  ]
}

function buildToolbarShortcutKeys() {
  return [
    KeyboardHandler.KeyV,
    KeyboardHandler.KeyM,
    KeyboardHandler.KeyL,
    KeyboardHandler.KeyW,
    KeyboardHandler.KeyC,
    KeyboardHandler.KeyI,
    KeyboardHandler.KeyJ,
    KeyboardHandler.KeyB,
    KeyboardHandler.KeyS,
    KeyboardHandler.KeyE,
    KeyboardHandler.KeyG,
    null,
    KeyboardHandler.KeyO,
    KeyboardHandler.KeyP,
    KeyboardHandler.KeyT,
    KeyboardHandler.KeyA,
    KeyboardHandler.KeyU,
    KeyboardHandler.KeyH,
    KeyboardHandler.KeyZ
  ]
}

// Transform tools not shown on the toolbar strip; activated by command or
// gesture and looked up in entriesById like any other tool.
function buildAuxiliaryToolEntries() {
  return [
    toolEntry(new FreeTransformTool(), TextLeadingOption),
    toolEntry(new WarpTool(), TextTrackingOption),
    toolEntry(new ContentAwareScaleTool(), TextBaselineOption),
    toolEntry(new PuppetWarpTool(), WarpOption)
  ]
}

// Non-tool listeners that share the tool entry table so documentAction events
// can route to them by id: history, layer effects/comps, layer-style dialog, and
// adjustment/smart-filter preview and apply.
function buildFilterTrackerEntries() {
  return [
    { tool: new TrackerRegistry.LayerEffectsTracker() },
    { tool: new TrackerRegistry.History() },
    { tool: new TrackerRegistry.LayerCompTracker() },
    { tool: new TrackerRegistry.LayerStyleDialogTracker() },
    { tool: new TrackerRegistry.AdjustmentPreviewTracker() },
    { tool: new TrackerRegistry.SmartFilterApplyTracker() }
  ]
}
