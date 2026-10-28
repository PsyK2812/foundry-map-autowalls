# Map Auto-Walls

Scans a scene's map image for walls and obstacles and places Foundry walls along them. You see the result drawn on the map and can tune it live before a single wall is created.

## Install
Add-on Modules → Install Module → paste this Manifest URL:

    https://github.com/PsyK2812/foundry-map-autowalls/releases/latest/download/module.json

Or unzip `module.zip` into `Data/modules/map-autowalls`.

## Use
- **Left toolbar → Walls → "Auto-Wall Scene from Map"** (wand icon), or
- **Right-click a scene** in the Scenes sidebar or top navigation → **Auto-Wall Scene**.

A panel opens beside the map. The map shows:
- **blue** – what the module thinks is wall,
- **pink lines with yellow dots** – the walls it would create.

Adjust until it looks right, then click **Create Walls**.

| Setting | What it does |
|---|---|
| Walls are | *Auto-detect* (default: tries every mode below and picks the one whose result looks most like walls; shown under the wall count, and you can switch if it picked wrong), *Darker than the floor* (most dungeon maps), *Lighter than the floor* (grey stone on dark ground), *Outlined in black* (walls the same colour as the floor, drawn with black outlines), *Straight building walls* (houses and buildings on busy outdoor maps; finds long straight wall lines and ignores trees and grass) *No walls* for outdoor maps — Auto-detect picks it when nothing looks like walls — or *A colour I pick* — click **Pick on map**, then click a wall. |
| Black-background maps | When the map sits on a black void and *Darker than the floor* has a cut-off above the void (so interior walls are found too), the outer walls are taken from the void's edge: on the outside face of the wall, and straight even where rubble covers its inside. |
| Also find inner walls | *Darker than the floor* only, off by default. For buildings on a dark background whose inner walls are drawn in the floor's colours (log cabins, timber houses): finds straight wall bands running from wall to wall, allowing door gaps, and ignores rugs, beds and patterns. Leave it off on dungeon maps — it adds stray lines through tables and pews there. |
| Brightness cut-off / Edge strength / Colour tolerance | How dark (or how close to the picked colour) a pixel must be to count as wall. In *Straight building walls* mode this is *Edge strength*: lower it if walls are missing, raise it if furniture gets walled. |
| Ignore lines thinner than | Removes the printed grid, cracks and hatching. Raise it until they vanish from the blue overlay. |
| Close gaps up to | Joins walls broken by small gaps or texture. Keep it below your door width or doorways get walled shut. |
| Solid areas wider than | Big dark areas (black void around a dungeon, solid rock) only get a wall along their edge, not through the middle. |
| Skip wall pieces shorter than | Drops small bits of debris. |
| Skip objects smaller than | Drops pillars, statues, rubble. Leave at 0 if pillars should block sight. |
| Wall position | 0 (default) = walls go down the **middle** of the drawn wall: thin walls by their centre line, walls that merge into rock or a dark surround half the measured wall thickness in from the floor, outer walls on black-background maps halfway between their floor and void sides. Where the middle can't be found (only the void's edge is visible), walls sit on the outside face, never the inside. Raise the slider to push walls further out. |
| Place tree trunks by clicking | Click trees on the map to put a small round wall (8 segments) on the trunk, so it blocks sight but the leaves don't. Click a trunk again to remove it, Esc to stop; the eraser removes all. *Trunk size* sets the width. Works with any mode. |
| Straighten to main lines (buildings) | On by default for *Straight building walls*. Snaps walls onto the building's long straight lines, runs them straight behind crates and furniture (no more detours), closes small breaks, keeps door gaps open, trims bits poking out past a wall and drops pieces that aren't connected to the building. Only for straight-walled buildings. Also works in the brightness and colour modes: tick it there and only long straight wall runs are kept, so rubble and debris against walls stop making wiggly walls. |
| Erase walls by dragging a box | Drag boxes over junk (carts, furniture, watermarks); the detected walls inside are cut away. Boxes stay while you change other settings. Undo removes the last box, ✕ removes all. |
| Straighten almost-straight walls | Makes nearly horizontal/vertical walls exactly straight. |
| Snap corners to grid | For maps whose walls follow the grid: snaps corners to full or half squares. |
| Detail | Fine is more accurate on curved caves, but slower on big maps. |
| Wall type | Normal, Terrain, Invisible or Ethereal. |

Settings are remembered per scene and as your default for the next map.

**Undo:** toolbar broom icon, or right-click the scene → **Remove Auto-Walls**. Only walls this module created are removed; walls you drew yourself stay.

Macro: `game.modules.get("map-autowalls").api.autoWall(scene)`

## Walls from a file
**Import walls file…** loads a `.json` file listing the walls for a map — for example one Claude made by looking at the map. With *Snap imported walls onto the drawn walls* ticked, each wall is nudged onto the drawn wall nearby. Imported walls show in the preview like any others, so you can erase or add detected walls before creating them.

File format (coordinates are pixels of the original map image):

```json
{
  "format": "map-autowalls", "version": 1,
  "image": { "width": 1600, "height": 1200 },
  "walls": [
    { "c": [197, 197, 1397, 197] },
    { "c": [699, 300, 699, 360], "door": "door" },
    { "c": [400, 500, 460, 500], "door": "secret" },
    { "c": [100, 900, 300, 900], "type": "terrain" }
  ]
}
```
`door` is `"door"` or `"secret"`; `type` is `normal`, `terrain`, `invisible`, `ethereal` or `window` (blocks movement, lets sight and light through). `"snap": false` keeps a wall exactly where the file puts it (used for outer walls placed on the outside face). If the scene's map has a different size, the walls are scaled to fit.

## Tips
- Align the grid first (e.g. with Grid Auto-Align) if you want to snap to it.
- Doors aren't detected. Openings are left open where the map shows a gap; click a wall and turn it into a door where needed.
- Furniture that's as dark as the walls gets walled too — lower the brightness cut-off, or delete those walls afterwards.
- Works on the scene background (image or video). Maps assembled from tiles aren't scanned. Maps hosted on another website without CORS can't be read.
- On Foundry v14 the walls go on the level you're viewing.
