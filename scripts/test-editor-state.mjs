// Regression tests against the real store; no browser, AI calls or persistent user data.
import assert from 'node:assert/strict'
import { createServer } from 'vite'
const memory = new Map()
globalThis.localStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, value),
  removeItem: (key) => memory.delete(key),
}
globalThis.window = { localStorage: globalThis.localStorage }
const vite = await createServer({
  configFile: false, optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true }, appType: 'custom',
  plugins: [{
    name: 'test-plan-storage', enforce: 'pre',
    transform(_source, id) {
      if (!id.endsWith('/src/lib/planImage.ts')) return
      return `export const PLAN_IMAGE_KEY = 'plan:image';
        let image, pendingLoad;
        export async function savePlanImage(value) { image = value }
        export async function loadPlanImage() {
          const value = image, wait = pendingLoad;
          pendingLoad = undefined;
          if (wait) await wait;
          return value;
        }
        export async function deletePlanImage() { image = undefined }
        export function delayNextLoad() {
          let release;
          pendingLoad = new Promise(resolve => { release = resolve });
          return release;
        }`
    },
  }],
})
try {
  const { useStore: store } = await vite.ssrLoadModule('/src/state/store.ts')
  const { roomsOverlap } = await vite.ssrLoadModule('/src/state/home.ts')
  const { allModels, getModel } = await vite.ssrLoadModule('/src/models/registry.ts')
  const eco = await vite.ssrLoadModule('/src/state/economy.ts')
  const imageStorage = await vite.ssrLoadModule('/src/lib/planImage.ts')
  const s = () => store.getState()
  // paid actions (rooms/placement) run against a padded wallet; economy rules
  // are asserted separately in the dedicated block below
  store.setState({ coins: 1_000_000 })
  s().newRoom()
  const originalId = s().activeRoomId
  s().setRoomRect(originalId, { ...s().home.rooms[0].rect, d: 8 })
  for (let i = 0; i < 5; i++) { s().selectRoom(originalId); s().addRoom('bedroom') }
  for (const a of s().home.rooms) for (const b of s().home.rooms) {
    if (a.id !== b.id) assert.equal(roomsOverlap(a, b), false, 'added rooms must never overlap')
  }
  const plan = s().exportProject()
  const homeBeforeNew = s().home
  s().newRoom()
  assert.equal(s().home.rooms.length, 1)
  s().undo()
  assert.equal(s().home, homeBeforeNew, 'new plan can restore the exact previous home')
  assert.equal(s().exportProject(), plan)
  s().redo()
  assert.equal(s().home.rooms.length, 1)
  s().undo()

  s().addFurniture('builtin:sofa')
  const id = s().selectedId
  const beforeDrag = s().exportProject()
  s().beginEdit()
  s().moveFurniture(id, 0.1, 0.2)
  s().moveFurniture(id, 0.4, 0.5)
  s().moveFurniture(id, 0.8, 0.9)
  s().endEdit()
  const afterDrag = s().exportProject()
  assert.notEqual(afterDrag, beforeDrag)
  s().undo()
  assert.equal(s().exportProject(), beforeDrag, 'a drag is undone in one step')
  s().redo()
  assert.equal(s().exportProject(), afterDrag)

  s().setScale(id, 1.1)
  const scaled = s().exportProject()
  s().undo()
  const stationary = s().furniture.find(f => f.id === id)
  assert.equal(s().canRedo, true)
  s().beginEdit()
  s().moveFurniture(id, ...stationary.position)
  s().endEdit()
  assert.equal(s().furniture.find(f => f.id === id), stationary, 'snapping to the same position does not edit furniture')
  assert.equal(s().canRedo, true, 'a stationary drag must preserve the redo branch')
  s().redo()
  assert.equal(s().exportProject(), scaled, 'the preserved redo restores the exact scaling edit')

  const handPlaced = s().exportProject()
  s().beginEdit()
  s().setExtras(30)
  s().setExtras(60)
  s().setExtras(70)
  s().endEdit()
  s().undo()
  assert.equal(s().exportProject(), handPlaced, 'one undo restores hand placement before density gesture')
  s().setRoomPartition(0.5)
  assert.equal(s().canRedo, false, 'new edit discards the redo branch')
  const beforeResize = s().exportProject()
  const active = s().home.rooms.find(r => r.id === s().activeRoomId)
  s().setRoomRect(active.id, { ...active.rect, d: 7.5 })
  s().undo()
  assert.equal(s().exportProject(), beforeResize, 'resizing restores exact furniture and openings')

  // Re-entering unchanged controls and deleting stale selections must preserve redo.
  s().addFurniture('builtin:sofa')
  const pristineId = s().selectedId
  s().setScale(pristineId, 1.2)
  s().undo()
  const pristineFurniture = s().furniture
  const opening = s().home.openings[0]
  if (opening) s().updateOpening(opening.id, { offset: opening.offset, width: opening.width })
  s().resetShape(pristineId)
  s().removeOpening('missing')
  s().removeFurniture('missing')
  s().rotateFurniture('missing', 1)
  s().setScale('missing', 1.5)
  s().setParam('missing', 'Width', 2)
  s().swapModel('missing', 'builtin:sofa')
  s().resetShape('missing')
  s().removeUpload('missing')
  assert.equal(s().furniture, pristineFurniture)
  assert.equal(s().canRedo, true, 'same-value controls and missing IDs preserve redo')
  s().redo()
  assert.equal(s().furniture.find(f => f.id === pristineId).scale, 1.2)

  // Imported external JSON must not introduce invalid types, IDs or geometry.
  const imported = {
    version: 1,
    home: {
      rooms: [
        { id: 'duplicate-room', type: 'unknown-type', rect: { x: 0, z: 0, w: 5, d: 5 } },
        { id: 'duplicate-room', type: 'bedroom', rect: { x: 8, z: 0, w: 5, d: 5 } },
      ],
      openings: [0, 1].map(() => ({ id: 'duplicate-opening', a: 'duplicate-room', b: 'exterior', kind: 'door', side: 'n', offset: 2, width: 1 })),
    },
    furniture: [0, 1].map(() => ({ id: 'duplicate-furniture', roomId: 'duplicate-room', modelId: 'builtin:sofa', params: { Width: 'bad', Depth: 99, Seats: null, Arms: 'false', Unknown: 100 } })),
  }
  assert.equal(s().importProject(JSON.stringify(imported)), null)
  assert.equal(s().home.rooms[0].type, 'living')
  const entityIds = [...s().home.rooms, ...s().home.openings, ...s().furniture].map(item => item.id)
  assert.equal(new Set(entityIds).size, entityIds.length, 'every imported editable entity has a unique ID')
  assert.equal(s().furniture[0].roomId, s().home.rooms[0].id, 'duplicate room references resolve consistently to the first room')
  assert.deepEqual(s().furniture[0].params, { Width: 2.3, Depth: 1.1, Seats: 3, Arms: true, Rounded: true })
  assert.ok(s().furniture.every(f => f.position.every(Number.isFinite)), 'invalid parameters cannot produce NaN positions')
  const preservedId = s().furniture[1].id
  s().removeFurniture(s().furniture[0].id)
  assert.deepEqual(s().furniture.map(f => f.id), [preservedId], 'deleting one imported item preserves the other')

  // Only storage functions are stubbed; reactive image and real history remain intact.
  const imageA = 'data:image/png;base64,AAAA'
  const imageB = 'data:image/png;base64,BBBB'
  s().importHome(homeBeforeNew, imageA)
  s().importHome(homeBeforeNew, imageB)
  assert.equal(s().planImageUrl, imageB, 'successive imports update the current image')
  s().undo()
  assert.equal(s().planImageUrl, imageA, 'image and layout share one history entry')
  s().redo()
  assert.equal(s().planImageUrl, imageB)
  s().newRoom()
  assert.equal(s().planImageUrl, null)
  s().undo()
  assert.equal(s().planImageUrl, imageB)
  assert.equal(s().importProject(plan), null)
  assert.equal(s().planImageKey, null, 'JSON import clears unrelated original plan')
  s().undo()
  assert.equal(s().planImageUrl, imageB)
  const persisted = JSON.parse(memory.get(store.persist.getOptions().name)).state
  assert.equal('planImageUrl' in persisted, false, 'image bytes must not enter localStorage')
  assert.equal('canUndo' in persisted, false, 'history must not persist')

  // Simulate the persisted key being available before IndexedDB image bytes.
  store.setState({ planImageKey: 'plan:image', planImageUrl: null })
  const releaseImage = imageStorage.delayNextLoad()
  const hydration = s().restorePlanImage()
  const heightBeforeHydration = s().wallHeight
  const windowsBeforeHydration = s().windows
  s().setStructure({ wallHeight: heightBeforeHydration + 0.1 })
  s().setStructure({ windows: !windowsBeforeHydration })
  s().undo() // Keep a pending image snapshot in both past and future.
  assert.equal(s().planImageUrl, null, 'image hydration stays under test control')
  releaseImage()
  await hydration
  assert.equal(s().planImageUrl, imageB)
  s().undo()
  assert.equal(s().wallHeight, heightBeforeHydration)
  assert.equal(s().planImageUrl, imageB, 'undoing an edit made before hydration retains the original image')
  assert.equal(await imageStorage.loadPlanImage(), imageB, 'undo must not delete the hydrated image from storage')
  s().redo()
  s().redo()
  assert.equal(s().windows, !windowsBeforeHydration)
  assert.equal(s().planImageUrl, imageB, 'redo snapshots made before hydration also retain the image')
  assert.equal(await imageStorage.loadPlanImage(), imageB)

  store.setState({ planImageKey: 'plan:image', planImageUrl: null })
  const releaseResetImage = imageStorage.delayNextLoad()
  const hydrationDuringReset = s().restorePlanImage()
  const homeBeforePendingReset = s().home
  s().newRoom()
  assert.equal(await imageStorage.loadPlanImage(), undefined, 'new plan clears the previous image slot')
  s().undo()
  assert.equal(s().home, homeBeforePendingReset)
  assert.equal(s().planImageUrl, null, 'undo may precede completion of image hydration')
  releaseResetImage()
  await hydrationDuringReset
  assert.equal(s().planImageUrl, imageB, 'hydration restores the original image after reset and undo')
  assert.equal(await imageStorage.loadPlanImage(), imageB, 'the restored image must survive a later page reload')

  // ---- 养成经济 Economy: pure rules, wallet gating, catalog, storage, claims ----
  assert.equal(eco.dailyReward(1), 100)
  assert.equal(eco.dailyReward(2), 120)
  assert.equal(eco.dailyReward(99), 200, 'daily reward caps out')
  assert.equal(eco.accruedIncome(10, 60_000), 10)
  assert.equal(eco.accruedIncome(10, 100 * 60 * 60_000), 10 * eco.INCOME_CAP_MINUTES, 'offline accrual caps')
  assert.equal(eco.expansionCost(4, 4, 6, 6), 200)
  assert.equal(eco.expansionCost(6, 6, 4, 4), 0, 'shrinking is free')
  assert.equal(eco.incomePerMinute({ rooms: [{}, {}] }, [{ modelId: 'a' }, { modelId: 'a' }, { modelId: 'b' }]), 6, 'duplicates do not farm income')
  assert.equal(eco.modelPrice(getModel('builtin:sofa')), 125, 'built-ins are half price')
  const glb = allModels().find(m => m.brand === 'KENNEY')
  assert.ok(eco.modelPrice(glb) > 0)

  // wallet gating: a broke player cannot place, unlock or grow the home
  s().newRoom()
  store.setState({ coins: 0, unlocked: [] })
  const furnitureBeforeReject = s().furniture
  s().addFurniture(glb.id)
  assert.equal(s().furniture, furnitureBeforeReject, 'insufficient coins reject placement')
  assert.ok(s().structureNotice.includes('金币不足'), 'rejection explains the shortfall')
  assert.equal(s().unlocked.includes(glb.id), false)

  // paid placement deducts, unlocks the catalog entry and is final on undo
  store.setState({ coins: eco.modelPrice(glb), structureNotice: null })
  s().addFurniture(glb.id)
  assert.ok(s().furniture.some(f => f.modelId === glb.id))
  assert.equal(s().coins, 0)
  assert.ok(s().unlocked.includes(glb.id), 'first paid placement unlocks the model')
  store.setState({ coins: 5_000 })
  s().addFurniture(glb.id)
  const coinsAfterSecondBuy = s().coins
  s().undo()
  assert.equal(s().coins, coinsAfterSecondBuy, 'undo removes furniture without refunding')
  assert.ok(s().furniture.some(f => f.modelId === glb.id), 'the first paid item survives the undo')

  // idle income and daily check-in are wallet writes outside history
  store.setState({ lastCollectAt: Date.now() - 60_000 })
  assert.ok(s().collectIncome() >= 1, 'a minute of income is collectable')
  assert.equal(s().collectIncome(), 0, 'nothing accrues after collecting')
  store.setState({ lastDailyDay: null, dailyStreak: 0 })
  assert.equal(s().claimDaily(), 100)
  assert.equal(s().claimDaily(), 0, 'the daily claim is once per day')
  store.setState({ lastDailyDay: eco.previousDayKey(), dailyStreak: 3 })
  assert.equal(s().claimDaily(), 160, 'streaks grow the daily reward')

  // storage round-trip is ordinary scene history (furniture + storage symmetric)
  store.setState({ coins: 5_000 })
  s().addFurniture('builtin:sofa')
  const coinsAroundStorage = s().coins // sofa placement paid; the stash/place round-trip below must not
  const storedTarget = s().selectedId
  s().storeFurniture(storedTarget)
  assert.equal(s().furniture.some(f => f.id === storedTarget), false)
  assert.equal(s().storage.length, 1)
  s().undo()
  assert.ok(s().furniture.some(f => f.id === storedTarget), 'undo restores a stored item')
  assert.equal(s().storage.length, 0, 'undo restores the storage list too')
  s().redo()
  assert.equal(s().storage.length, 1)
  s().placeFromStorage(s().storage[0].id)
  assert.ok(s().furniture.some(f => f.id === storedTarget))
  assert.equal(s().storage.length, 0)
  assert.equal(s().coins, coinsAroundStorage, 'storing and placing back are free')

  // auto-layout draws only from the ownership catalog
  store.setState({ furniture: [], storage: [], unlocked: [] })
  const coinsBeforeRoom = s().coins
  s().addRoom('bedroom')
  const added = s().home.rooms.find(r => r.id === s().activeRoomId)
  assert.ok(added)
  assert.equal(coinsBeforeRoom - s().coins, eco.roomAreaCost(added.rect.w, added.rect.d), 'a new room costs its area')
  assert.ok(s().furniture.length > 0, 'bedroom still lays out with built-ins')
  assert.ok(s().furniture.every(f => getModel(f.modelId).kind === 'parametric'), 'no GLB outside the catalog is generated')
  const owned = eco.ownedModelIds(s())
  assert.ok(s().furniture.every(f => owned.has(f.modelId)), 'generated models stay inside the catalog')

  // shrinking is free; growth charges the added area
  const first = s().home.rooms[0]
  s().selectRoom(first.id)
  const coinsBeforeShrink = s().coins
  s().setRoomRect(first.id, { ...first.rect, w: Math.max(1.5, first.rect.w - 1) })
  assert.equal(s().coins, coinsBeforeShrink, 'shrinking a room is free')
  const shrunk = s().home.rooms.find(r => r.id === first.id)
  s().setRoomRect(first.id, { ...shrunk.rect, w: shrunk.rect.w + 1 })
  assert.equal(
    coinsBeforeShrink - s().coins,
    eco.expansionCost(shrunk.rect.w, shrunk.rect.d, shrunk.rect.w + 1, shrunk.rect.d),
    'growing a room charges the added area',
  )

  // structure selection: clicking a wall (WallStrip) is session state, mutually exclusive with openings
  const wallRoom = s().home.rooms[0]
  s().selectRoom(wallRoom.id)
  s().selectWall({ roomId: wallRoom.id, side: 's' })
  assert.equal(s().selectedWall?.side, 's')
  const openingsBefore = s().home.openings.length
  s().addOpening({ kind: 'door', a: wallRoom.id, b: 'exterior', side: 's', offset: 1, width: 0.9 })
  assert.equal(s().home.openings.length, openingsBefore + 1)
  s().selectOpening(s().home.openings.at(-1).id)
  assert.equal(s().selectedWall, null, 'selecting an opening clears the wall selection')
  s().selectWall({ roomId: wallRoom.id, side: 's' })
  assert.equal(s().selectedOpeningId, null, 'selecting a wall clears the opening selection')
  assert.equal(s().selectedId, null, 'selecting a wall clears the furniture selection')
  s().selectWall(null)

  console.log('editor-state OK: overlap, reset, undo/redo, gesture grouping, no-op redo preservation, regeneration, delayed image hydration and persistence, economy (pricing, wallet gating, catalog, storage, income and daily claims), wall/opening selection')
} finally {
  await vite.close()
}
