/**
 * LiteLoaderQQNT - Tray Account Indicator
 *
 * Automatically detects logged-in QQ accounts on Linux,
 * replaces the ambiguous `chrome_status_icon_1` system tray tooltip,
 * updates the tray icon with the user's high-definition circular avatar,
 * and synchronizes the main window title for dock/taskbar previews.
 *
 * @author deadalux
 * @license MIT
 */

const electron = require("electron");
const { app, nativeImage } = electron;
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const http = require("http");

let activeTray = null;
let activeWindow = null;
let currentUin = null;
let currentNick = null;
let pollTimer = null;

const CONFIG_PATH = path.join(os.homedir(), ".config/LiteLoaderQQNT/data/tray_account_indicator/config.json");

/**
 * Load optional user configuration
 */
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
        }
    } catch {}
    return { showAvatar: true, customLabels: {} };
}

/**
 * Apply a circular alpha mask with anti-aliasing to raw RGBA/BGRA bitmap data.
 * Zero external dependencies.
 */
function makeCircularAvatar(srcBuffer, size = 32) {
    try {
        const img = nativeImage.createFromBuffer(srcBuffer);
        const resized = img.resize({ width: size, height: size, quality: "best" });
        const bmp = resized.toBitmap();
        const r = (size / 2) - 1;
        const cx = size / 2 - 0.5;
        const cy = size / 2 - 0.5;

        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const idx = (y * size + x) * 4;
                const dx = x - cx;
                const dy = y - cy;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist > r + 0.5) {
                    bmp[idx + 3] = 0;
                } else if (dist > r - 0.5) {
                    const alphaFactor = (r + 0.5 - dist);
                    bmp[idx + 3] = Math.round(bmp[idx + 3] * Math.max(0, Math.min(1, alphaFactor)));
                }
            }
        }
        return nativeImage.createFromBitmap(bmp, { width: size, height: size });
    } catch (err) {
        console.error("[Tray Account Indicator] Failed to create circular avatar:", err);
        return null;
    }
}

/**
 * Download high-definition avatar from Tencent CDN and cache locally
 */
function downloadAvatar(uin, cachePath, callback) {
    try {
        if (fs.existsSync(cachePath)) {
            const stat = fs.statSync(cachePath);
            if (stat.size > 0 && (Date.now() - stat.mtimeMs < 7 * 86400 * 1000)) {
                return callback(null, fs.readFileSync(cachePath));
            }
        }
    } catch {}

    const fetchUrl = (targetUrl, redirects = 0) => {
        if (redirects > 3) return callback(new Error("Too many redirects"));
        const mod = targetUrl.startsWith("https") ? https : http;
        mod.get(targetUrl, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchUrl(res.headers.location, redirects + 1);
            }
            if (res.statusCode !== 200) {
                return callback(new Error(`HTTP status ${res.statusCode}`));
            }
            const chunks = [];
            res.on("data", chunk => chunks.push(chunk));
            res.on("end", () => {
                const buf = Buffer.concat(chunks);
                try {
                    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
                    fs.writeFileSync(cachePath, buf);
                } catch {}
                callback(null, buf);
            });
        }).on("error", (err) => callback(err));
    };

    fetchUrl(`https://q1.qlogo.cn/g?b=qq&s=100&nk=${uin}`);
}

/**
 * Detect current instance UIN deterministically using Linux process file descriptors
 */
function detectUin() {
    // 1. Primary: Scan /proc/self/fd for /nt_data/Login/.<UIN>
    try {
        const fds = fs.readdirSync("/proc/self/fd");
        for (const fd of fds) {
            try {
                const link = fs.readlinkSync(`/proc/self/fd/${fd}`);
                const m = link.match(/\/nt_data\/Login\/\.(\d+)/);
                if (m && m[1]) return m[1];
            } catch {}
        }
    } catch {}

    // 2. Secondary: Match open files with UnitedConfig account directories
    try {
        const qqBase = path.join(os.homedir(), ".var/app/com.qq.QQ/config/QQ");
        if (fs.existsSync(qqBase)) {
            const fds = fs.readdirSync("/proc/self/fd");
            const openPaths = [];
            for (const fd of fds) {
                try {
                    openPaths.push(fs.readlinkSync(`/proc/self/fd/${fd}`));
                } catch {}
            }

            const dirs = fs.readdirSync(qqBase);
            for (const d of dirs) {
                if (d.startsWith("nt_qq_")) {
                    const isOpen = openPaths.some(p => p.includes(d));
                    if (isOpen) {
                        const unitedDir = path.join(qqBase, d, "nt_data/UnitedConfig");
                        if (fs.existsSync(unitedDir)) {
                            const list = fs.readdirSync(unitedDir).filter(n => /^\d+$/.test(n));
                            if (list.length > 0) return list[0];
                        }
                    }
                }
            }
        }
    } catch {}

    return null;
}

/**
 * Update Tray tooltip, tray title, avatar image, and main window title
 */
function updateVisuals() {
    if (!currentUin) return;

    const cfg = loadConfig();
    const customLabel = cfg.customLabels?.[currentUin];
    const displayName = customLabel || currentNick;
    const label = displayName ? `${displayName} (${currentUin})` : `QQ (${currentUin})`;
    console.log(`[Tray Account Indicator] Updating visuals for account: ${label}`);

    // 1. Update Tray Tooltip & Title (StatusNotifierItem on D-Bus)
    if (activeTray) {
        try {
            activeTray.setToolTip(`QQ - ${label}`);
            activeTray.setTitle(displayName || currentUin);
        } catch (e) {
            console.warn("[Tray Account Indicator] Failed to set tray tooltip/title:", e);
        }

        // Update Tray Icon with avatar if enabled
        if (cfg.showAvatar !== false) {
            const cacheDir = path.join(os.homedir(), ".config/LiteLoaderQQNT/data/tray_account_indicator");
            const cacheFile = path.join(cacheDir, `${currentUin}.jpg`);
            downloadAvatar(currentUin, cacheFile, (err, buf) => {
                if (err || !buf) {
                    console.warn("[Tray Account Indicator] Could not fetch avatar:", err);
                    return;
                }
                const circle = makeCircularAvatar(buf, 32);
                if (circle && activeTray) {
                    try {
                        activeTray.setImage(circle);
                        console.log(`[Tray Account Indicator] Successfully updated tray icon to avatar for ${currentUin}`);
                    } catch (e) {
                        console.warn("[Tray Account Indicator] Failed to set tray image:", e);
                    }
                }
            });
        }
    }

    // 2. Update Window Title
    if (activeWindow && !activeWindow.isDestroyed()) {
        try {
            activeWindow.setTitle(`QQ - ${label}`);
        } catch (e) {}
    }
}

function checkAccount() {
    const uin = detectUin();
    if (uin && uin !== currentUin) {
        currentUin = uin;
        console.log(`[Tray Account Indicator] Detected account UIN: ${currentUin}`);
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
        updateVisuals();
    }
}

function startPolling() {
    checkAccount();
    if (!currentUin && !pollTimer) {
        pollTimer = setInterval(checkAccount, 1000);
    }
}

function bindTray(tray) {
    if (!tray || activeTray === tray) return;
    activeTray = tray;
    console.log("[Tray Account Indicator] Tray bound successfully.");
    startPolling();
    if (currentUin) {
        updateVisuals();
    }
}

function bindWindow(window) {
    if (!window || activeWindow === window) return;
    activeWindow = window;

    // Enforce window title
    const enforceTitle = () => {
        if (!currentUin) return;
        const cfg = loadConfig();
        const customLabel = cfg.customLabels?.[currentUin];
        const displayName = customLabel || currentNick;
        const label = displayName ? `${displayName} (${currentUin})` : `QQ (${currentUin})`;
        try {
            window.setTitle(`QQ - ${label}`);
        } catch {}
    };

    window.on("page-title-updated", (event) => {
        if (currentUin) {
            event.preventDefault();
            enforceTitle();
        }
    });

    window.webContents.on("did-finish-load", async () => {
        startPolling();
        // Attempt to extract nickname
        try {
            const nick = await window.webContents.executeJavaScript(`(() => {
                try {
                    if (window.nt_api?.getSelfInfo) {
                        const info = window.nt_api.getSelfInfo();
                        if (info?.nickName || info?.nick) return info.nickName || info.nick;
                    }
                } catch {}
                try {
                    const el = document.querySelector(".sidebar-user-avatar, .sidebar-avatar, [class*=\"self-avatar\"], [class*=\"sidebar\"] [class*=\"avatar\"]");
                    if (el) {
                        if (el.title) return el.title;
                        const img = el.querySelector("img");
                        if (img && img.title) return img.title;
                        if (img && img.alt) return img.alt;
                    }
                } catch {}
                return null;
            })()`);

            if (nick && nick !== currentNick) {
                currentNick = nick;
                console.log(`[Tray Account Indicator] Detected account nickname: ${currentNick}`);
                updateVisuals();
            }
        } catch {}
    });

    startPolling();
}

// Fallback: direct subclass hook on electron.Tray
if (electron.Tray) {
    const OriginalTray = electron.Tray;
    class PatchedTray extends OriginalTray {
        constructor(...args) {
            super(...args);
            bindTray(this);
        }
    }
    Object.setPrototypeOf(PatchedTray, OriginalTray);
    electron.Tray = PatchedTray;
}

module.exports = {
    onLoad() {
        startPolling();
    },
    onTrayCreated(tray) {
        bindTray(tray);
    },
    onBrowserWindowCreated(window) {
        bindWindow(window);
    },
    onLogin(uid) {
        startPolling();
    },
    onKernelIpc(cmdName, payload) {
        if (cmdName === "nodeIKernelProfileListener/onUserDetailInfoChanged") {
            const nick = payload?.info?.simpleInfo?.coreInfo?.nick || payload?.info?.nick;
            const uin = payload?.info?.uin;
            if (uin && (!currentUin || currentUin === uin)) {
                currentUin = uin;
                if (nick && nick !== currentNick) {
                    currentNick = nick;
                    updateVisuals();
                }
            }
        }
    }
};
