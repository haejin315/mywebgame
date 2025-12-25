const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

const startOverlay = document.getElementById("start-overlay");
const startBtn = document.getElementById("start-btn");

// ====== 상태 ======
let running = false;
let last = 0;

// ====== Viewport(화면) ======
let viewW = 0; // CSS px 기준
let viewH = 0;

// ====== World(실제 맵) ======
const WORLD_SCALE = 30; // 월드 = 화면의 30배
let worldW = 0;
let worldH = 0;

// ====== Camera(월드에서 화면이 보는 위치) ======
const camera = { x: 0, y: 0 }; // 월드 좌표(좌상단)

// ====== MiniMap ======
const minimap = {
    pad: 16,
    size: 180,
    border: 2,
};

function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
}

function clampCamera() {
    const viewWorldW = viewW / zoom;
    const viewWorldH = viewH / zoom;

    camera.x = clamp(camera.x, 0, Math.max(0, worldW - viewWorldW));
    camera.y = clamp(camera.y, 0, Math.max(0, worldH - viewWorldH));
}

// ====== 클릭/드래그 판정 ======
const CLICK_TOL = 6; // px: 이 이하면 "클릭", 초과면 "드래그(패닝/미니맵드래그)"

// 포인터 상태
let pointerDown = false;
let downScreen = { x: 0, y: 0 };
let lastScreen = { x: 0, y: 0 };
let dragging = false;
let downInMinimap = false;

// pointerdown 시점의 "커서 아래 월드좌표"를 잡아둠
let anchorWorld = { x: 0, y: 0 };

// ====== Zoom ======
let zoom = 1.0;
const ZOOM_MIN = 0.5; // 2배 축소
const ZOOM_MAX = 1.0; // 최대 확대(현재 상태)

let playTime = 0; // seconds

let dragMode = "none"; // "none" | "pan" | "minimap"

// ====== Tower(네모) 설정 ======
const GRID = 40;
const TOWER_SIZE = 40;     // ✅ 네모 크기 40

const towers = []; // { id, x, y, cd, range, fireEvery, dmg }  // x,y는 "타워 중심(=격자 꼭지점)" 좌표로 저장
let selectedTowerId = null;

let nextTowerId = 1;

// 선택 상태
let selectedTower = false;

// ===== Enemy =====
let enemy_speed = 50;         // units/sec (월드좌표)
const ENEMY_RADIUS = 10;        // 적 충돌 반지름(적 크기)
let spawn_min = 500;
let spawn_max = 1000;
let enemy_hp = 0;


let spawnEvery = 3.0;           // n초마다 (원하는 값으로 바꿔)
let spawnAcc = 0;

let enemies = [];               // {id, x, y, hp}
let nextEnemyId = 1;

// ===== Wave =====
const WAVE_DURATION = 60;   // 1분
let lastWaveIndex = 0; // floor(playTime / 60) 저장용
let wave = 1;

// ===== Tower attack =====
let bullet_speed = 300;
let range_radius = 300;  // 기본 사거리 300
const BULLET_LEN = 30;       // 레이저 선 길이(연출용)
const BULLET_WIDTH = 2;      // 바늘처럼 얇게
let tower_cost = 10;
let toast = null;
let tower_fire_every = 1; // 초당 1발 정도

const MAX_FIRE_EVERY = 0.01;   // 공격속도 최소
const MAX_BULLET_SPEED = 1500;
const MAX_RANGE = 10000;

let bullets = [];            // {id, x, y, px, py, dx, dy, traveled}
let nextBulletId = 1;

let gold = 10;
// ===== Upgrade Costs =====
let upgradeCostDmg = 20;
let upgradeCostSpeed = 25;
let upgradeCostRange = 30;
let upgradeCostBullet = 35;

let gameSpeed = 1.0; // 1배속

let gameOver = false;

// UI 엘리먼트
const upgradeUI = document.getElementById("upgrade-ui");

function getScreenPos(e) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
    };
}

// 화면 좌표 -> 월드 좌표 (카메라 고려)
function screenToWorld(sx, sy) {
    return {
        x: camera.x + sx / zoom,
        y: camera.y + sy / zoom,
    };
}

/* 캔버스 리사이즈 (CSS 픽셀 좌표계 사용) */
function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();

    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);

    // ctx를 CSS 픽셀 좌표로 사용
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    viewW = rect.width;
    viewH = rect.height;

    worldW = viewW * WORLD_SCALE;
    worldH = viewH * WORLD_SCALE;

    clampCamera();
}

window.addEventListener("resize", resize);
resize();

canvas.addEventListener("pointerdown", (e) => {
    if (!running) return;

    pointerDown = true;
    canvas.setPointerCapture(e.pointerId);

    const s = getScreenPos(e);
    downScreen = { ...s };
    lastScreen = { ...s };

    // down 시점에는 판단하지 않음. 단, "어디에서 눌렀는지"만 기록
    const mmr = getMinimapRect();
    downInMinimap = isInRect(s.x, s.y, mmr);

    dragMode = "none"; // 아직은 모름
});

canvas.addEventListener("pointermove", (e) => {
    if (!running || !pointerDown) return;

    const s = getScreenPos(e);
    lastScreen = { ...s };

    // 아직 드래그 모드가 결정되지 않았다면, 일정 거리 이상 움직였을 때만 시작
    if (dragMode === "none") {
        if (dist2Obj(s, downScreen) <= CLICK_TOL * CLICK_TOL) return;

        // 여기부터 "드래그"로 확정
        if (downInMinimap) {
            dragMode = "minimap";
        } else {
            dragMode = "pan";
            // pan 드래그 시작 순간에 앵커 월드좌표를 잡아야, 줌에서도 자연스럽다
            const w = screenToWorld(downScreen.x, downScreen.y); // 줌 포함
            anchorWorld.x = w.x;
            anchorWorld.y = w.y;
        }
    }

    // 드래그 중 처리
    if (dragMode === "minimap") {
        const w = minimapToWorld(s.x, s.y);
        const viewWorldW = viewW / zoom;
        const viewWorldH = viewH / zoom;
        camera.x = w.x - viewWorldW / 2;
        camera.y = w.y - viewWorldH / 2;
        clampCamera();
        return;
    }

    if (dragMode === "pan") {
        camera.x = anchorWorld.x - s.x / zoom;
        camera.y = anchorWorld.y - s.y / zoom;
        clampCamera();
    }
});

canvas.addEventListener("pointerup", (e) => {
    if (!running) return;

    pointerDown = false;

    const up = getScreenPos(e);
    const isClick = dist2Obj(up, downScreen) <= CLICK_TOL * CLICK_TOL;


    // 클릭이면 여기서만 "클릭 행동" 처리
    if (isClick) {
        if (downInMinimap) {
            // ✅ 미니맵 클릭: 해당 위치로 점프
            const w = minimapToWorld(up.x, up.y);
            const viewWorldW = viewW / zoom;
            const viewWorldH = viewH / zoom;

            camera.x = w.x - viewWorldW / 2;
            camera.y = w.y - viewWorldH / 2;
            clampCamera();
        } else {
            // ✅ 월드 클릭: 네모 클릭 여부 판정
            const w = screenToWorld(up.x, up.y);

            // 1) 기존 타워를 클릭했나? (위에 있는 타워부터 선택하고 싶으면 역순 탐색)
            let hit = null;
            for (let i = towers.length - 1; i >= 0; i--) {
                if (pointInTower(w.x, w.y, towers[i])) {
                    hit = towers[i];
                    break;
                }
            }
            if (hit) {
                selectTower(hit.id);
                return;
            }

            // 2) 타워가 아니라면: 격자 꼭지점 근처 클릭이면 새 타워 생성
            const gp = getGridPointIfNear(w.x, w.y);   // 격자 꼭지점 스냅

            if (gp) {
                const before = gold;
                const t = addTowerAtGridPoint(gp.x, gp.y);

                if (!t) {
                    // ✅ 돈 부족 메시지 (또는 월드 밖 등으로 실패했을 때)
                    if (before < tower_cost) showToast("not enough gold", up.x, up.y);
                    return;
                }

                selectTower(t.id);
                return;
            }

            // 3) 아무것도 아니면 선택 해제
            clearSelection();
        }
    }

    // 드래그 종료
    dragMode = "none";
});

canvas.addEventListener("pointercancel", () => {
    pointerDown = false;
    dragMode = "none";
    dragging = false;
});

canvas.addEventListener("wheel", (e) => {
    if (!running) return;
    e.preventDefault();

    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    // 🔑 휠 방향: 아래로 = 축소
    const zoomFactor = 1.1;
    let nextZoom =
        e.deltaY > 0 ? zoom / zoomFactor : zoom * zoomFactor;

    nextZoom = clamp(nextZoom, ZOOM_MIN, ZOOM_MAX);

    if (nextZoom === zoom) return;

    // ✅ 줌 전, 커서 아래 월드 좌표
    const before = screenToWorld(sx, sy);

    zoom = nextZoom;

    // ✅ 줌 후에도 같은 월드 좌표가 커서 아래에 오도록 카메라 보정
    camera.x = before.x - sx / zoom;
    camera.y = before.y - sy / zoom;

    clampCamera();
}, { passive: false });

/* Start 버튼 */
startBtn.addEventListener("click", () => {
    playTime = 0;
    startOverlay.style.display = "none";
    running = true;
    lastWaveIndex = 0;
    // ✅ 시작은 월드 정중앙을 보도록 카메라를 중앙에 배치
    camera.x = (worldW - viewW) / 2;
    camera.y = (worldH - viewH) / 2;
    clampCamera();

    // 시작 타워
    const cx = snapToGrid(worldW / 2);
    const cy = snapToGrid(worldH / 2);
    const t = addTowerAtGridPoint(cx, cy);
    selectTower(t.id);

    last = performance.now();
    requestAnimationFrame(loop);
    applyWave(1);
    updateUpgradeUI();
});

/* 업데이트 (패닝은 이벤트에서 카메라를 직접 바꾸므로 비워둠) */
function update(dt) {
    if (gameOver) return;

    // 스폰
    spawnAcc += dt;
    while (spawnAcc >= spawnEvery) {
        spawnAcc -= spawnEvery;
        spawnEnemy();
    }

    updateEnemies(dt);

    // 3) 타워 발사
    updateTowerFire(dt);

    // 4) 총알 이동 + 적 피격 처리
    updateBullets(dt);

    const waveIndex = Math.floor(playTime / WAVE_DURATION); // 0부터 시작
    if (waveIndex !== lastWaveIndex) {
        lastWaveIndex = waveIndex;
        applyWave(1 + waveIndex);
    }
}

/* 월드 렌더링 (그리드 + 기준점) */
function renderWorld() {
    ctx.save();
    ctx.scale(zoom, zoom);
    ctx.translate(-camera.x, -camera.y);


    // 배경
    ctx.fillStyle = "#0f0f12";
    ctx.fillRect(0, 0, worldW, worldH);

    // ✅ 격자: 40 간격(얇게) + 200 간격(굵게) 예시
    // (너가 원하면 40만 그려도 됨)
    for (let x = 0; x <= worldW; x += GRID) {
        ctx.strokeStyle = (x % (GRID * 5) === 0) ? "#2a2a35" : "#1f1f28";
        ctx.lineWidth = (x % (GRID * 5) === 0) ? 2 : 1;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, worldH); ctx.stroke();
    }
    for (let y = 0; y <= worldH; y += GRID) {
        ctx.strokeStyle = (y % (GRID * 5) === 0) ? "#2a2a35" : "#1f1f28";
        ctx.lineWidth = (y % (GRID * 5) === 0) ? 2 : 1;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(worldW, y); ctx.stroke();
    }

    // ✅ 타워들
    const half = TOWER_SIZE / 2;
    for (const t of towers) {
        const isSel = (t.id === selectedTowerId);
        ctx.fillStyle = isSel ? "#ffd166" : "#c9c9c9";
        ctx.fillRect(t.x - half, t.y - half, TOWER_SIZE, TOWER_SIZE);
    }

    // ✅ 선택된 타워 사거리
    const sel = getSelectedTower();
    if (sel) {
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = "#00ffcc";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(sel.x, sel.y, sel.range, 0, Math.PI * 2);
        ctx.stroke();

        ctx.globalAlpha = 0.08;
        ctx.fillStyle = "#00ffcc";
        ctx.fill();
        ctx.restore();
    }

    // ✅ 적들
    ctx.fillStyle = "#ff4d4d";
    for (const e of enemies) {
        ctx.beginPath();
        ctx.arc(e.x, e.y, ENEMY_RADIUS, 0, Math.PI * 2);
        ctx.fill();
    }

    ctx.lineWidth = BULLET_WIDTH;
    ctx.strokeStyle = "#00ffcc";
    ctx.globalAlpha = 0.9;

    for (const b of bullets) {
        // 현재 위치에서 반대 방향으로 길이만큼 꼬리 선을 그려 레이저 느낌
        const x2 = b.x;
        const y2 = b.y;
        const x1 = b.x - b.dx * BULLET_LEN;
        const y1 = b.y - b.dy * BULLET_LEN;

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
    }

    ctx.fillStyle = "#fff";
    ctx.font = "12px sans-serif";
    for (const e of enemies) {
        ctx.fillText(String(e.hp), e.x + 12, e.y - 12);
    }

    ctx.restore();
}



/* 미니맵 렌더링 */
function renderMinimap() {
    const mm = minimap.size;
    const x0 = viewW - minimap.pad - mm;
    const y0 = viewH - minimap.pad - mm;

    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = "#0b0b0d";
    ctx.fillRect(x0, y0, mm, mm);

    const sx = mm / worldW;
    const sy = mm / worldH;

    // 축소 그리드 느낌
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = "#2a2a35";
    ctx.lineWidth = 1;

    const stepX = GRID * 5 * sx;
    const stepY = GRID * 5 * sy;

    for (let i = 0; i <= mm; i += stepX) {
        ctx.beginPath();
        ctx.moveTo(x0 + i, y0);
        ctx.lineTo(x0 + i, y0 + mm);
        ctx.stroke();
    }
    for (let i = 0; i <= mm; i += stepY) {
        ctx.beginPath();
        ctx.moveTo(x0, y0 + i);
        ctx.lineTo(x0 + mm, y0 + i);
        ctx.stroke();
    }

    // 현재 뷰포트 표시
    const viewRectX = x0 + camera.x * sx;
    const viewRectY = y0 + camera.y * sy;
    const viewRectW = (viewW / zoom) * sx;
    const viewRectH = (viewH / zoom) * sy;

    ctx.globalAlpha = 1.0;
    ctx.strokeStyle = "#00ffcc";
    ctx.lineWidth = 2;
    ctx.strokeRect(viewRectX, viewRectY, viewRectW, viewRectH);

    // 월드 중심 점도 미니맵에 표시
    ctx.fillStyle = "#ffd166";
    ctx.beginPath();
    ctx.arc(x0 + (worldW / 2) * sx, y0 + (worldH / 2) * sy, 3, 0, Math.PI * 2);
    ctx.fill();

    // 테두리
    ctx.strokeStyle = "#444";
    ctx.lineWidth = minimap.border;
    ctx.strokeRect(x0, y0, mm, mm);

    ctx.restore();
}

/* 드래그 UI 표시(선택) */
function renderDragIndicator() {
    if (!dragging) return;

    // 현재 카메라 좌표 HUD
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = "#fff";
    ctx.font = "16px sans-serif";
    ctx.fillText(`Camera: (${Math.round(camera.x)}, ${Math.round(camera.y)})`, 16, 28);
    ctx.restore();
}

function getMinimapRect() {
    const mm = minimap.size;
    return {
        x: viewW - minimap.pad - mm,
        y: viewH - minimap.pad - mm,
        w: mm,
        h: mm,
    };
}

function isInRect(px, py, r) {
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

function minimapToWorld(sx, sy) {
    const r = getMinimapRect();
    const mx = (sx - r.x) / r.w; // 0~1
    const my = (sy - r.y) / r.h; // 0~1
    return {
        x: clamp(mx, 0, 1) * worldW,
        y: clamp(my, 0, 1) * worldH,
    };
}

function formatTime(sec) {
    sec = Math.max(0, sec);
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function renderPlayTime() {
    const timeText = `TIME  ${formatTime(playTime)}`;
    const waveText = `WAVE  ${wave}`;
    const goldText = `GOLD  ${gold}`;

    ctx.save();
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = "#fff";

    ctx.font = "20px sans-serif";
    const w1 = ctx.measureText(timeText).width;
    ctx.fillText(timeText, (viewW - w1) / 2, 28);

    ctx.font = "16px sans-serif";
    const w2 = ctx.measureText(waveText).width;
    ctx.fillText(waveText, (viewW - w2) / 2, 52);

    ctx.font = "18px sans-serif";
    ctx.fillText(goldText, 16, 26);

    ctx.restore();
}

function showToast(text, sx, sy, ms = 900) {
    toast = { text, x: sx, y: sy, until: performance.now() + ms };
}

function renderToast() {
    if (!toast) return;
    if (performance.now() > toast.until) { toast = null; return; }

    ctx.save();
    ctx.globalAlpha = 0.95;
    ctx.font = "16px sans-serif";
    ctx.fillStyle = "#ff8080";
    ctx.fillText(toast.text, toast.x + 12, toast.y - 12);
    ctx.restore();
}

function renderSelectedTowerInfo() {
    const t = getSelectedTower();

    const pad = 16;
    const x = viewW - pad;  // 오른쪽 기준
    const y = 26;

    ctx.save();
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = "#fff";
    ctx.font = "16px sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "top";

    if (!t) {
        ctx.fillText("No tower selected", x, y);
        ctx.restore();
        return;
    }

    // ✅ 출력 내용(원하는 항목 더 추가 가능)
    const lines = [
        `Tower #${t.id}`,
        `DMG: ${t.dmg}`,
        `FireSpeed: ${t.fireEvery.toFixed(2)}s`,
        `Range: ${Math.round(t.range)}`,
        `BulletSpeed: ${Math.round(t.bulletSpeed)}`,
        `Upgrade Costs`,
        `  Damage: ${t.costDmg}`,
        `  FireSpeed: ${t.costSpeed}`,
        `  Range: ${t.costRange}`,
        `  BulletSpeed: ${t.costBullet}`,
    ];

    for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], x, y + i * 20);
    }

    ctx.restore();
}


function snapToGrid(v) {
    return Math.round(v / GRID) * GRID;
}

function dist2Obj(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
}

function dist2Num(ax, ay, bx, by) {
    const dx = ax - bx;
    const dy = ay - by;
    return dx * dx + dy * dy;
}

function getSelectedTower() {
    return towers.find(t => t.id === selectedTowerId) || null;
}

function selectTower(id) {
    // ✅ 같은 타워를 다시 선택하면 비활성화(선택 해제)
    if (selectedTowerId === id) {
        clearSelection();
        return;
    }

    selectedTowerId = id;
    showUpgradeUI(true);
    updateUpgradeUI();
}

function clearSelection() {
    selectedTowerId = null;
    showUpgradeUI(false);
    updateUpgradeUI();
}

function pointInTower(wx, wy, tower) {
    const half = TOWER_SIZE / 2;
    return (
        wx >= tower.x - half && wx <= tower.x + half &&
        wy >= tower.y - half && wy <= tower.y + half
    );
}

// 타워가 이미 있는지(같은 격자점 중복 방지)
function findTowerAtGridPoint(gx, gy) {
    // 정확히 같은 격자점에만 1개 허용
    return towers.find(t => t.x === gx && t.y === gy) || null;
}

// "격자 꼭지점(스냅 포인트)" 근처인지 판정
function getGridPointIfNear(wx, wy) {
    const gx = snapToGrid(wx);
    const gy = snapToGrid(wy);

    // 허용 반경: 화면상 10px 정도를 월드로 환산(줌 반영)
    const tolWorld = 10 / zoom;
    if (dist2Num(wx, wy, gx, gy) <= tolWorld * tolWorld) {
        return { x: gx, y: gy };
    }
    return null;
}

function addTowerAtGridPoint(gx, gy) {
    if (gx < 0 || gy < 0 || gx > worldW || gy > worldH) return null;

    const existing = findTowerAtGridPoint(gx, gy);
    if (existing) return existing; // 이미 있으면 그걸 선택

    // ✅ 생성 비용 10골드
    if (gold < tower_cost) return null;

    gold -= tower_cost;

    // ✅ 타워 성능을 타워 객체에 “독립 변수”로 저장
    const t = {
        id: nextTowerId++,
        x: gx,
        y: gy,

        // 발사 쿨다운
        cd: 0,

        // ===== 타워 스탯(타워마다 독립) =====
        range: range_radius,     // 기본 300 :contentReference[oaicite:4]{index=4}
        fireEvery: tower_fire_every, // 기본 1초 :contentReference[oaicite:5]{index=5}
        dmg: 1,                  // 총알 데미지(기본 1)
        bulletSpeed: bullet_speed, // 총알 속도

        costDmg: 20,
        costSpeed: 25,
        costRange: 30,
        costBullet: 35,
    };

    towers.push(t);
    return t;
}


function showUpgradeUI(show) {
    if (show) upgradeUI.classList.remove("hidden");
    else upgradeUI.classList.add("hidden");
}

function dist(ax, ay, bx, by) {
    const dx = ax - bx, dy = ay - by;
    return Math.hypot(dx, dy);
}

function nearestTower(x, y) {
    if (towers.length === 0) return null;
    let best = null;
    let bestD2 = Infinity;
    for (const t of towers) {
        const dx = t.x - x, dy = t.y - y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) { bestD2 = d2; best = t; }
    }
    return best; // tower object
}

function randomInRange(a, b) {
    return a + Math.random() * (b - a);
}

function randomSpawnPos() {
    // 타워가 없으면 스폰 못함
    if (towers.length === 0) return null;

    // 최대 시도 횟수(무한루프 방지)
    for (let tries = 0; tries < 500; tries++) {
        const x = Math.random() * worldW;
        const y = Math.random() * worldH;

        const t = nearestTower(x, y);
        if (!t) return null;

        const d = dist(x, y, t.x, t.y);
        if (d >= spawn_min && d <= spawn_max) {
            return { x, y };
        }
    }

    // 만약 월드/타워 배치 때문에 조건이 너무 빡세서 실패하면:
    // 가장 가까운 타워 하나를 골라 그 타워 링에서 직접 뽑는 “폴백”
    const base = towers[Math.floor(Math.random() * towers.length)];
    const angle = Math.random() * Math.PI * 2;
    const r = randomInRange(spawn_min, spawn_max);
    let x = base.x + Math.cos(angle) * r;
    let y = base.y + Math.sin(angle) * r;

    x = clamp(x, 0, worldW);
    y = clamp(y, 0, worldH);
    return { x, y };
}

function spawnEnemy() {
    const p = randomSpawnPos();
    if (!p) return;
    enemies.push({ id: nextEnemyId++, x: p.x, y: p.y, hp: enemy_hp });
}

function nearestEnemyInRange(tx, ty, range) {
    if (enemies.length === 0) return null;
    const r2 = range * range;

    let best = null;
    let bestD2 = Infinity;

    for (const e of enemies) {
        const dx = e.x - tx;
        const dy = e.y - ty;
        const d2 = dx * dx + dy * dy;

        if (d2 <= r2 && d2 < bestD2) {
            bestD2 = d2;
            best = e;
        }
    }
    return best;
}

function fireBulletFromTower(t) {
    const e = nearestEnemyInRange(t.x, t.y, t.range); // ✅ 사거리 내만
    if (!e) return; // 사거리 내 적이 없으면 발사 안 함

    const dx = e.x - t.x;
    const dy = e.y - t.y;
    const len = Math.hypot(dx, dy) || 1;

    bullets.push({
        id: nextBulletId++,
        x: t.x, y: t.y,
        px: t.x, py: t.y,
        dx: dx / len, dy: dy / len,
        traveled: 0,
        dmg: t.dmg,          // 타워별 데미지
        speed: t.bulletSpeed,
    });
}

function segmentHitsCircle(x1, y1, x2, y2, cx, cy, r) {
    const vx = x2 - x1, vy = y2 - y1;
    const wx = cx - x1, wy = cy - y1;

    const vv = vx * vx + vy * vy;
    if (vv === 0) return dist2Num(x1, y1, cx, cy) <= r * r;

    let t = (wx * vx + wy * vy) / vv;
    t = Math.max(0, Math.min(1, t));

    const px = x1 + t * vx;
    const py = y1 + t * vy;

    const dx = px - cx, dy = py - cy;
    return (dx * dx + dy * dy) <= r * r;
}

function updateTowerFire(dt) {
    if (enemies.length === 0) return;

    for (const t of towers) {
        t.cd -= dt;
        if (t.cd <= 0) {
            fireBulletFromTower(t);
            t.cd = t.fireEvery;
        }
    }
}

function updateBullets(dt) {
    if (bullets.length === 0) return;

    const deadBullets = new Set();
    const deadEnemies = new Set();

    for (const b of bullets) {
        // 이전 위치 저장
        b.px = b.x;
        b.py = b.y;

        // 이동
        const step = b.speed * dt;
        b.x += b.dx * step;
        b.y += b.dy * step;
        b.traveled += step;

        // 최대 사거리
        if (b.traveled >= b.range) {
            deadBullets.add(b.id);
            continue;
        }

        // 충돌(총알 선분 vs 적 원)
        for (const e of enemies) {
            if (deadEnemies.has(e.id)) continue;

            const hit = segmentHitsCircle(b.px, b.py, b.x, b.y, e.x, e.y, ENEMY_RADIUS);
            if (hit) {
                e.hp -= b.dmg;
                deadBullets.add(b.id);

                if (e.hp <= 0) {
                    deadEnemies.add(e.id);
                    gold += killRewardGold();
                }
                break;
            }
        }
    }

    if (deadBullets.size > 0) bullets = bullets.filter(b => !deadBullets.has(b.id));
    if (deadEnemies.size > 0) enemies = enemies.filter(e => !deadEnemies.has(e.id));
}

/* 루프 */
function loop(now) {
    if (!running) return;

    const dt = (now - last) / 1000 * gameSpeed;
    last = now;

    playTime += dt;

    update(dt);

    ctx.clearRect(0, 0, viewW, viewH);
    renderWorld();
    renderMinimap();
    renderDragIndicator();
    renderPlayTime();
    renderToast();
    renderSelectedTowerInfo();
    renderGameOver();

    requestAnimationFrame(loop);
}

function updateEnemies(dt) {
    if (towers.length === 0) return;

    // 이동
    for (const e of enemies) {
        const t = nearestTower(e.x, e.y);
        if (!t) break;

        const dx = t.x - e.x;
        const dy = t.y - e.y;
        const len = Math.hypot(dx, dy) || 1;

        const vx = (dx / len) * enemy_speed;
        const vy = (dy / len) * enemy_speed;

        e.x += vx * dt;
        e.y += vy * dt;
    }

    // 충돌 처리 (적이 타워에 닿으면 둘 다 제거)
    // 여러 충돌이 동시에 날 수 있으니 "삭제 목록"으로 모아서 한 번에 제거
    const deadEnemyIds = new Set();
    const deadTowerIds = new Set();

    for (const e of enemies) {
        if (deadEnemyIds.has(e.id)) continue;

        // 닿음 판정: 적-타워 중심거리 <= (타워 반쪽 + 적 반지름)
        for (const t of towers) {
            if (deadTowerIds.has(t.id)) continue;

            const touchDist = (TOWER_SIZE / 2) + ENEMY_RADIUS;
            const d = dist(e.x, e.y, t.x, t.y);

            if (d <= touchDist) {
                deadEnemyIds.add(e.id);
                deadTowerIds.add(t.id);
                break;
            }
        }
    }

    if (deadEnemyIds.size > 0) {
        enemies = enemies.filter(e => !deadEnemyIds.has(e.id));
    }
    if (deadTowerIds.size > 0) {
        // 선택된 타워가 죽었으면 UI도 정리
        const sel = selectedTowerId;
        for (const id of deadTowerIds) {
            if (id === sel) {
                clearSelection();
                break;
            }
        }
        for (const id of deadTowerIds) {
            const idx = towers.findIndex(t => t.id === id);
            if (idx >= 0) towers.splice(idx, 1);
        }
    }

    // 타워가 다 사라지면 게임오버
    if (towers.length === 0) {
        gameOver = true;
        running = false;          // 루프 중지(원하면 멈추고 오버레이 띄우기)
        showUpgradeUI(false);
    }
}

function killRewardGold() {
    const mult = 1 + 0.02 * towers.length;
    return Math.round(wave * mult);
}

function canAfford(cost) {
    return gold >= cost;
}

function pay(cost) {
    gold -= cost;
}

function increaseCost(cost) {
    return Math.round(cost * 1.1);
}

function upgradeDamage(btn) {
    const t = getSelectedTower();
    if (!t) return; // 타워 선택 안 된 상태면 무시(원하면 토스트도 가능)

    if (gold < t.costDmg) {
        toastAtButton(btn);
        return;
    }

    gold -= t.costDmg;
    t.dmg += 1;

    t.costDmg = increaseCost(t.costDmg);
    updateUpgradeUI();
}

function upgradeFireSpeed(btn) {
    const t = getSelectedTower();
    if (!t) return;

    if (t.fireEvery <= MAX_FIRE_EVERY) return;

    if (gold < t.costSpeed) {
        toastAtButton(btn);
        return;
    }

    gold -= t.costSpeed;
    t.fireEvery = Math.max(0.01, t.fireEvery * 0.96); // 10% 빨라짐

    t.costSpeed = increaseCost(t.costSpeed);
    updateUpgradeUI();
}

function upgradeRange(btn) {
    const t = getSelectedTower();
    if (!t) return;

    if (t.range >= MAX_RANGE) return;

    if (gold < t.costRange) {
        toastAtButton(btn);
        return;
    }

    gold -= t.costRange;
    t.range += 25;

    t.costRange = increaseCost(t.costRange);
    spawn_min += 25;
    spawn_max += 25;

    updateUpgradeUI();
}

function upgradeBulletSpeed(btn) {
    const t = getSelectedTower();
    if (!t) return;

    if (t.bulletSpeed >= MAX_BULLET_SPEED) return;

    if (gold < t.costBullet) {
        toastAtButton(btn);
        return;
    }

    gold -= t.costBullet;
    t.bulletSpeed += 30;

    t.costBullet = increaseCost(t.costBullet);
    updateUpgradeUI();
}


function applyWave(w) {
    if (w > wave) {
        gold = Math.round(gold * 1.10); // ✅ 10% 증가, 정수 반올림
    }

    wave = w;

    // 예시 규칙(원하면 바꿔줄게)
    enemy_hp = 1 + (w - 1);                 // 웨이브마다 HP +1
    enemy_speed = 50 + (w - 1) * 5;            // 웨이브마다 속도 +5
    spawnEvery = Math.max(0.05, 3.0 * Math.pow(0.9, (w - 1))); // 점점 빨라짐
}

function renderGameOver() {
    if (!gameOver) return;
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = "#fff";
    ctx.font = "48px sans-serif";
    const text = "GAME OVER";
    const w = ctx.measureText(text).width;
    ctx.fillText(text, (viewW - w) / 2, viewH / 2);
    ctx.restore();
}

function updateUpgradeUI() {
    const t = getSelectedTower();
    const b1 = document.querySelector('.upg-btn[data-upg="1"]');
    const b2 = document.querySelector('.upg-btn[data-upg="2"]');
    const b3 = document.querySelector('.upg-btn[data-upg="3"]');
    const b4 = document.querySelector('.upg-btn[data-upg="4"]');

    if (!b1) return;

    if (!t) {
        b1.textContent = "Damage";
        b2.textContent = "FireSpeed";
        b3.textContent = "Range";
        b4.textContent = "BulletSpeed";
        return;
    }

    b1.textContent = `Damage (${t.costDmg})`;
    b2.textContent = `FireSpeed (${t.costSpeed})`;
    b3.textContent = `Range (${t.costRange})`;
    b4.textContent = `BulletSpeed (${t.costBullet})`;

    // ✅ MAX 도달 시 버튼 비활성화
    b2.disabled = t.fireEvery <= MAX_FIRE_EVERY;
    b3.disabled = t.range >= MAX_RANGE;
    b4.disabled = t.bulletSpeed >= MAX_BULLET_SPEED;
    b1.disabled = false;
}

function toastAtButton(btn, text = "not enough gold") {
    const r = btn.getBoundingClientRect();
    // 캔버스 기준 좌표로 변환(캔버스가 화면 어디에 있는지 반영)
    const c = canvas.getBoundingClientRect();
    const sx = (r.left + r.right) / 2 - c.left;
    const sy = r.top - c.top; // 버튼 위쪽에 뜨게

    showToast(text, sx, sy);
}

document.querySelectorAll(".upg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
        const type = btn.dataset.upg;

        if (type === "1") upgradeDamage(btn);
        else if (type === "2") upgradeFireSpeed(btn);
        else if (type === "3") upgradeRange(btn);
        else if (type === "4") upgradeBulletSpeed(btn);
    });
});

const speedBtn = document.getElementById("speedToggle");
function updateSpeedBtn() {
    speedBtn.textContent = `x${gameSpeed}`;
}
updateSpeedBtn();

speedBtn.addEventListener("click", () => {
    gameSpeed += 1;
    if (gameSpeed > 5) gameSpeed = 1;
    updateSpeedBtn();
});