import { motion, AnimatePresence, useAnimation } from "framer-motion";
import { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef, memo } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getVersion } from "@tauri-apps/api/app";
import type { UpdateCheckResult } from "./updater";
import { batteryTooltip, type BatteryDetails } from "./batteryTooltip";
import {
	createRegionSender,
	measureElements,
	notchPillBox,
	type RegionRect
} from "./windowRegion";
import "./App.css";
import { initTheme } from "./theme";
import {
	PlayIcon,
	PauseIcon,
	SkipBackIcon,
	SkipForwardIcon,
	VolumeLowIcon,
	VolumeHighIcon,
	MusicNoteIcon,
	HeadphonesIcon
} from "./icons";
import { CompactMediaPlayer } from "./CompactMediaPlayer";
import { useWeather } from "./hooks/useWeather";
import { useSettingsSync } from "./hooks/useSettingsSync";
import { useTrailingThrottle } from "./hooks/useTrailingThrottle";
import { useAnnouncement } from "./hooks/useAnnouncement";
import { reloadIfMirrorWasStale } from "./hooks/settingsMirror";
import { openUrl } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import type { WidgetConfig } from "./components/StatusWidgetConfig";
import { EdgeSurface } from "./components/EdgeSurface";
import { ShelfTypeIcon } from "./components/ShelfTypeIcon";
import { WifiPanel } from "./components/WifiPanel";
import { BluetoothPanel } from "./components/BluetoothPanel";
import { DeviceArt, DeviceArtDefs } from "./devices/DeviceArt";
import { deviceArtFor } from "./devices/deviceArtFor";
import { deviceLookFor } from "./devices/deviceLooks";
import type { BudLevel, BudsBattery } from "./devices/connectedDevices";
import { ConnectedDevicesPanel } from "./components/ConnectedDevicesPanel";
import { Calendar, calendarRows } from "./components/Calendar";
import { useConnectedDevices } from "./hooks/useConnectedDevices";
import { isWiredAudio, usbArtFor, usbDisplayName, type UsbIdentity } from "./devices/usbArtFor";
import type { DeviceArtKey } from "./devices/art";
import {
	Cpu,
	MemoryStick,
	HardDrive,
	ArrowUpDown,
	Bell,
	BellRing,
	Play,
	Pause,
	RotateCcw,
	Megaphone,
	Type,
	X,
	ChevronLeft,
	ChevronRight,
	Inbox,
	Music,
	Zap,
	VolumeX,
	Volume,
	Volume1,
	Volume2,
	SunDim,
	SunMedium,
	Sun,
	Clipboard,
	Globe,
	Code,
	Check,
	Trash2,
	FileText,
	ZoomIn,
	ZoomOut,
	Maximize2,
	Copy
} from "lucide-react";

/**
 * The notch has two kinds of content:
 * - Panels are tools the user chooses. A click opens the last-used panel by
 *   default, or a selected fixed panel when panel memory is turned off.
 * - Live activities (music, a set timer, a filled shelf) show a compact form in
 *   the pill or a bubble beside it, and opening one shows its own view, which
 *   stands alone (no panel arrows) and is never remembered as the last panel.
 *   Dragging files onto the notch also opens the shelf. Wheel/swipe switches
 *   between tool panels, including when a live activity occupies the pill.
 */
type NotchPanel = "calendar" | "command-center" | "devices";
const NOTCH_PANELS: readonly NotchPanel[] = ["calendar", "command-center", "devices"];
const asNotchPanel = (value: unknown): NotchPanel | null =>
	NOTCH_PANELS.includes(value as NotchPanel) ? (value as NotchPanel) : null;

// The Connected devices panel grows with its list between these heights;
// the maximum is the size the panel had before it grew to fit.
const COMMAND_CENTER_WIDTH = 375;
const DEVICES_MIN_HEIGHT = 150;
const DEVICES_MAX_HEIGHT = 300;

// Pomodoro timer limit.
const MAX_TIMER_SECONDS = 180 * 60;

// Accept both mm:ss and compact digits ("130" -> 1:30).
const timerDigitsToSeconds = (value: string): number | null => {
	if (!/^\d{1,5}$/.test(value) && !/^\d{1,3}:\d{1,2}$/.test(value)) return null;
	const [minutes, seconds] = value.includes(":")
		? value.split(":")
		: [value.slice(0, -2) || "0", value.slice(-2)];
	const secs = Number(seconds);
	const total = Number(minutes) * 60 + secs;
	return secs < 60 && total > 0 && total <= MAX_TIMER_SECONDS ? total : null;
};

const timerSecondsToDigits = (seconds: number): string => {
	const mins = Math.floor(seconds / 60);
	const secs = seconds % 60;
	return `${mins}${secs.toString().padStart(2, "0")}`.replace(/^0+(?=\d)/, "");
};

const formatTimerDigits = (digits: string): string => {
	digits = digits.replace(/\D/g, "");
	if (!digits) return "0:00";
	const secs = digits.slice(-2).padStart(2, "0");
	const mins = parseInt(digits.slice(0, -2) || "0", 10);
	return `${mins}:${secs}`;
};

// Completion chime for the Pomodoro timer. Synthesized with the Web Audio API
// so no audio asset is needed; created on the Start click so the webview's
// autoplay policy lets it play when the timer ends.
let timerChimeCtx: AudioContext | null = null;

const getTimerChimeCtx = (): AudioContext | null => {
	try {
		if (!timerChimeCtx) timerChimeCtx = new AudioContext();
		if (timerChimeCtx.state === "suspended") timerChimeCtx.resume().catch(() => {});
		return timerChimeCtx;
	} catch {
		return null;
	}
};

const playTimerChime = () => {
	const ctx = getTimerChimeCtx();
	if (!ctx) return;
	const start = ctx.currentTime + 0.02;
	const master = ctx.createGain();
	master.gain.value = 0.45;
	master.connect(ctx.destination);

	// Soft rising bell arpeggio (A5–C#6–E6) with a quiet octave harmonic.
	const notes = [
		{ freq: 880.0, at: 0 },
		{ freq: 1108.73, at: 0.18 },
		{ freq: 1318.51, at: 0.36 }
	];
	notes.forEach(({ freq, at }) => {
		const osc = ctx.createOscillator();
		const harmonic = ctx.createOscillator();
		const gain = ctx.createGain();
		const harmonicGain = ctx.createGain();
		osc.type = "sine";
		osc.frequency.value = freq;
		harmonic.type = "sine";
		harmonic.frequency.value = freq * 2.01;
		harmonicGain.gain.value = 0.12;
		gain.gain.setValueAtTime(0.0001, start + at);
		gain.gain.exponentialRampToValueAtTime(0.32, start + at + 0.02);
		gain.gain.exponentialRampToValueAtTime(0.0001, start + at + 1.4);
		osc.connect(gain);
		harmonic.connect(harmonicGain);
		harmonicGain.connect(gain);
		gain.connect(master);
		osc.start(start + at);
		harmonic.start(start + at);
		osc.stop(start + at + 1.5);
		harmonic.stop(start + at + 1.5);
	});
};

// Simple SVG icons
function WifiIcon({ enabled, connected }: { enabled: boolean; connected: boolean }) {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			opacity={!enabled ? 0.4 : connected ? 1 : 0.7}
		>
			<path d="M5 12.55a11 11 0 0 1 14.08 0" />
			<path d="M1.42 9a16 16 0 0 1 21.16 0" />
			<path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
			<line x1="12" y1="20" x2="12.01" y2="20" />
		</svg>
	);
}

function TrayIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<rect x="3" y="3" width="6" height="6" rx="1" />
			<rect x="15" y="3" width="6" height="6" rx="1" />
			<rect x="15" y="15" width="6" height="6" rx="1" />
			<rect x="3" y="15" width="6" height="6" rx="1" />
		</svg>
	);
}

function BatteryIcon({
	charging,
	level,
	threshold = 20
}: {
	charging: boolean;
	level: number;
	threshold?: number;
}) {
	const percentage = Math.min(Math.max(level, 0), 100);

	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				position: "relative",
				height: "14px",
				justifyContent: "center"
			}}
		>
			<svg width="20" height="10" viewBox="0 0 20 10" fill="none">
				{/* Battery Shell - Centered at 9px within 20px width, ignoring the tip's offset */}
				<rect
					x="2"
					y="0.75"
					width="14"
					height="8.5"
					rx="2.4"
					stroke="currentColor"
					strokeOpacity={0.35}
					strokeWidth="1.1"
				/>
				{/* Battery Tip */}
				<path
					d="M17.5 3.5V6.5"
					stroke="currentColor"
					strokeOpacity={0.35}
					strokeWidth="1.2"
					strokeLinecap="round"
				/>
				{/* Fill */}
				<rect
					x="3.8"
					y="2.5"
					width={Math.max(0.5, (percentage / 100) * 10.4)}
					height="5"
					rx="1"
					fill={charging ? "#32D74B" : percentage <= threshold ? "#FF453A" : "white"}
				/>
			</svg>
			{/* Charging Bolt - Centered on the battery body */}
			{charging && (
				<div
					style={{
						position: "absolute",
						top: "50%",
						left: "9px",
						transform: "translate(-50%, -50%)",
						color: "white",
						filter: "drop-shadow(0px 0px 1.5px rgba(0,0,0,0.8))"
					}}
				>
					<svg width="7" height="10" viewBox="0 0 8 12" fill="currentColor">
						<path d="M4.5 0L0 7H3.5L2.5 12L8 5H4.5L5.5 0H4.5Z" />
					</svg>
				</div>
			)}
		</div>
	);
}

function GreenDownArrowIcon() {
	return (
		<div
			style={{
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
				width: "18px",
				height: "18px",
				borderRadius: "50%",
				background: "rgba(50, 215, 75, 0.15)",
				border: "1px solid rgba(50, 215, 75, 0.35)",
				boxShadow: "0 0 8px rgba(50, 215, 75, 0.25)",
				flexShrink: 0,
				verticalAlign: "middle"
			}}
		>
			<svg
				width="10"
				height="10"
				viewBox="0 0 24 24"
				fill="none"
				stroke="#32D74B"
				strokeWidth="3"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<line x1="12" y1="4" x2="12" y2="16"></line>
				<polyline points="18 10 12 16 6 10"></polyline>
				<line x1="6" y1="20" x2="18" y2="20"></line>
			</svg>
		</div>
	);
}

export const Visualizer = memo(function Visualizer({
	isPlaying,
	bars = 5,
	height = 20
}: {
	isPlaying: boolean;
	bars?: number;
	height?: number;
}) {
	const [audioData, setAudioData] = useState<number[]>(new Array(bars).fill(0.18));

	useEffect(() => {
		if (!isPlaying) {
			setAudioData(new Array(bars).fill(0.18));
			return;
		}

		const unlisten = listen<{ frequencies: number[] }>("audio-visualization", (event) => {
			// If we receive fewer frequencies than bars, repeat or interpolate
			// If more, slice
			let data = event.payload.frequencies;
			if (data.length > bars) data = data.slice(0, bars);
			while (data.length < bars) data.push(0.18);
			setAudioData(data);
		});

		return () => {
			unlisten.then((fn) => fn());
		};
	}, [isPlaying, bars]);

	return (
		<div
			className="visualizer-horizontal"
			style={{ height: `${height}px`, width: `${bars * 6}px` }}
		>
			{audioData.map((value, i) => (
				<motion.div
					key={i}
					className="bar-horizontal"
					animate={{
						scaleY: isPlaying ? Math.max(0.2, value) : 0.1,
						opacity: isPlaying ? 0.95 : 0.5
					}}
					transition={{
						type: "spring",
						stiffness: 600,
						damping: 30,
						mass: 0.5
					}}
				/>
			))}
		</div>
	);
});

// Odometer-style digit for the timer clock. When the value changes the old
// digit rolls up and out while the new one rolls in from below with a slight
// 3D tilt — no card chrome, just the numerals.
const RollDigit = memo(function RollDigit({
	value,
	compact = false
}: {
	value: string;
	compact?: boolean;
}) {
	return (
		<span className={`roll-digit ${compact ? "compact" : ""}`}>
			<AnimatePresence initial={false}>
				<motion.span
					key={value}
					className="roll-num"
					initial={{ y: "72%", rotateX: -50, opacity: 0 }}
					animate={{ y: "0%", rotateX: 0, opacity: 1 }}
					exit={{ y: "-72%", rotateX: 50, opacity: 0 }}
					transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
				>
					{value}
				</motion.span>
			</AnimatePresence>
		</span>
	);
});

interface MediaInfo {
	title: string;
	artist: string;
	is_playing: boolean;
	has_media: boolean;
	artwork?: string[];
	position_ms?: number;
	duration_ms?: number;
	seek_enabled?: boolean;
	position_updated_at?: number;
}

interface WifiStatus {
	enabled: boolean;
	connected: boolean;
	ssid: string | null;
}

// A shelf file's preview from the backend: a picture when one can be made,
// else the opening text of a document or text file, and whether it's a folder
// (for the placeholder icon).
interface ShelfPreview {
	thumb: string | null;
	text: string | null;
	folder: boolean;
}

interface ShelfItem {
	id: string;
	type: "file" | "text";
	name: string;
	path?: string;
	text?: string;
	timestamp: number;
}

interface ClipboardItem {
	id: string;
	content: string;
	kind: "url" | "hex" | "code" | "text" | "image";
	timestamp: number;
	width?: number;
	height?: number;
}

type BloomMode =
	| "music"
	| "calendar"
	| "command-center"
	| "announcement"
	| "status"
	| "shelf"
	| "clipboard"
	| "wifi"
	| "bluetooth"
	| "devices"
	| "device"
	| "notification"
	| "notifications";

export interface AppNotification {
	id: number;
	app_name: string;
	app_id: string;
	title: string;
	body: string;
	timestamp: number;
}

function formatRelativeTime(timestampSecs: number): string {
	const diff = Math.floor(Date.now() / 1000 - timestampSecs);
	if (diff < 60) return "just now";
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
	return new Date(timestampSecs * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function AppBrandIcon({ appName, appId }: { appName: string; appId: string }) {
	const lower = (appName + " " + appId).toLowerCase();

	if (lower.includes("whatsapp")) {
		return (
			<div className="notif-brand-icon notif-whatsapp" title="WhatsApp">
				<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
					<path d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2m.01 1.67c4.54 0 8.24 3.7 8.24 8.24 0 2.2-.86 4.27-2.42 5.82a8.18 8.18 0 0 1-5.82 2.41c-1.42 0-2.82-.37-4.06-1.07l-.29-.17-3.12.82.83-3.04-.19-.3a8.21 8.21 0 0 1-1.26-4.47c0-4.54 3.7-8.24 8.24-8.24m4.52 11.66c-.25-.13-1.47-.72-1.7-.81-.23-.08-.39-.12-.56.13-.17.25-.64.81-.79.97-.14.17-.29.19-.54.06-.25-.13-1.06-.39-2.02-1.25-.75-.67-1.25-1.5-1.4-1.75-.15-.25-.02-.39.11-.51.11-.11.25-.29.38-.44.12-.14.17-.25.25-.42.08-.17.04-.32-.02-.45s-.56-1.35-.77-1.85c-.2-.48-.41-.42-.56-.43h-.48c-.17 0-.44.06-.67.31-.23.25-.88.86-.88 2.1s.9 2.44 1.02 2.61c.13.17 1.77 2.7 4.29 3.79.6.26 1.07.41 1.44.53.6.19 1.15.16 1.58.1.48-.07 1.47-.6 1.68-1.18.21-.58.21-1.07.15-1.18-.06-.11-.23-.17-.48-.3" />
				</svg>
			</div>
		);
	}

	if (lower.includes("telegram")) {
		return (
			<div className="notif-brand-icon notif-telegram" title="Telegram">
				<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
					<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2m4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 0 0-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.75-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38" />
				</svg>
			</div>
		);
	}

	if (lower.includes("discord")) {
		return (
			<div className="notif-brand-icon notif-discord" title="Discord">
				<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
					<path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.894.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
				</svg>
			</div>
		);
	}

	if (lower.includes("claude")) {
		return (
			<div className="notif-brand-icon notif-claude" title="Claude">
				<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
					<path d="M12 2a1.5 1.5 0 0 1 1.5 1.5v4.086l2.89-2.89a1.5 1.5 0 0 1 2.12 2.122l-2.89 2.89h4.088a1.5 1.5 0 0 1 0 3h-4.088l2.89 2.89a1.5 1.5 0 0 1-2.122 2.12l-2.888-2.888V20.5a1.5 1.5 0 0 1-3 0v-4.088l-2.89 2.89a1.5 1.5 0 1 1-2.12-2.122l2.89-2.89H3.5a1.5 1.5 0 0 1 0-3h4.088L4.7 8.39a1.5 1.5 0 1 1 2.122-2.12l2.888 2.888V3.5A1.5 1.5 0 0 1 12 2z" />
				</svg>
			</div>
		);
	}

	if (lower.includes("antigravity") || lower.includes("code")) {
		return (
			<div className="notif-brand-icon notif-antigravity" title="Antigravity">
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
					<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
				</svg>
			</div>
		);
	}

	if (lower.includes("terminal") || lower.includes("powershell") || lower.includes("pwsh") || lower.includes("cmd")) {
		return (
			<div className="notif-brand-icon notif-terminal" title="Terminal">
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
					<polyline points="4 17 10 11 4 5" />
					<line x1="12" y1="19" x2="20" y2="19" />
				</svg>
			</div>
		);
	}

	return (
		<div className="notif-brand-icon notif-generic">
			<BellRing size={16} strokeWidth={2.4} />
		</div>
	);
}

// A device that just connected or disconnected, shown briefly in the pill.
interface DeviceAlert {
	// The device's id, so a later battery report can find its alert.
	id: string;
	art: DeviceArtKey;
	name: string;
	connected: boolean;
	battery: number | null;
	// Each bud's and the case's battery, for earbuds that report them.
	buds?: BudsBattery | null;
	// A USB device, which has no list to open when the alert is clicked.
	usb?: boolean;
	// Changes on every alert, so the drawing replays its animation.
	runId: number;
}

// As sent by the backend's `bluetooth-connection` event.
interface BluetoothConnection {
	id: string;
	name: string;
	kind: string;
	form: string | null;
	connected: boolean;
	battery: number | null;
}

/** A USB device plugged in or removed, from the backend's `usb-connection`. */
interface UsbConnection extends UsbIdentity {
	/** The device's container id. */
	id: string;
	connected: boolean;
}

// What a device alert says: wired and USB devices are plugged in, cards
// inserted, everything else connected.
const PLUGGED_ART = new Set<DeviceArtKey>([
	"headphones-wired",
	"earbuds-usbc",
	"earbuds-jack",
	"flash-drive",
	"ssd",
	"hub",
	"webcam",
	"microphone"
]);
function deviceAlertStatus(art: DeviceArtKey, connected: boolean, wired = false): string {
	if (art === "sd-card") return connected ? "Inserted" : "Removed";
	// A wired device is plugged in whatever it was picked to look like.
	if (wired || PLUGGED_ART.has(art)) return connected ? "Plugged in" : "Unplugged";
	return connected ? "Connected" : "Disconnected";
}

// How long a device alert stays in the pill.
const DEVICE_ALERT_MS = { connected: 4200, disconnected: 2600 };
// How many alerts for other devices can wait behind the one showing.
const DEVICE_ALERT_QUEUE = 3;

/** A small ring showing a device's battery, with the level in the middle. */
function DeviceBatteryRing({ level, charging = false }: { level: number; charging?: boolean }) {
	const r = 10.5;
	const circumference = 2 * Math.PI * r;
	const low = level <= 20 && !charging;
	return (
		<div
			className={`device-alert-battery${low ? " low" : ""}${charging ? " charging" : ""}`}
			title={`${level}%${charging ? ", charging" : ""}`}
		>
			<svg viewBox="0 0 28 28" width="28" height="28">
				<circle cx="14" cy="14" r={r} className="track" />
				<circle
					cx="14"
					cy="14"
					r={r}
					className="level"
					strokeDasharray={`${(circumference * level) / 100} ${circumference}`}
					transform="rotate(-90 14 14)"
				/>
			</svg>
			<span>{level}</span>
		</div>
	);
}

// Each bud's and the case's battery, for earbuds that report them: a ring
// per part with its label underneath. Parts with no reading are left out.
function DeviceBudsBattery({ buds }: { buds: BudsBattery }) {
	const parts: [string, BudLevel][] = [];
	if (buds.left) parts.push(["L", buds.left]);
	if (buds.right) parts.push(["R", buds.right]);
	if (buds.case) parts.push(["Case", buds.case]);
	return (
		<div className="device-alert-buds">
			{parts.map(([label, part]) => (
				<div key={label} className="device-alert-bud">
					<DeviceBatteryRing level={part.level} charging={part.charging} />
					<span className="device-alert-bud-label">
						{label}
						{part.charging && <Zap className="device-alert-bud-charging" />}
					</span>
				</div>
			))}
		</div>
	);
}

// The shelf is a short-lived stash: one row, newest first, oldest evicted.
const SHELF_MAX_ITEMS = 10;

const MARQUEE_SPEED = 30; // px/s — constant for all titles
const MARQUEE_MIN_DURATION = 5; // floor so short titles don't flicker

const TitleMarquee = ({ title }: { title: string }) => {
	const textRef = useRef<HTMLSpanElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const [isOverflowing, setIsOverflowing] = useState(false);
	const [scrollDistance, setScrollDistance] = useState(0);
	const [scrollDuration, setScrollDuration] = useState(8);

	useEffect(() => {
		const check = () => {
			if (textRef.current && containerRef.current) {
				const textWidth = textRef.current.scrollWidth;
				const containerWidth = containerRef.current.clientWidth;
				const overflow = textWidth > containerWidth;
				setIsOverflowing(overflow);
				if (overflow) {
					const distance = textWidth - containerWidth;
					setScrollDistance(distance);
					setScrollDuration(Math.max(distance / MARQUEE_SPEED, MARQUEE_MIN_DURATION));
				}
			}
		};
		check();
		const observer = new ResizeObserver(check);
		if (containerRef.current) observer.observe(containerRef.current);
		return () => observer.disconnect();
	}, [title]);

	return (
		<div
			ref={containerRef}
			className="premium-title-wrap"
			style={{ width: "100%", overflow: "hidden" }}
		>
			<span
				ref={textRef}
				className={`premium-title ${isOverflowing ? "marquee" : ""}`}
				style={
					{
						"--scroll-distance": isOverflowing ? `-${scrollDistance}px` : undefined,
						"--scroll-duration": `${scrollDuration}s`
					} as React.CSSProperties
				}
			>
				{title}
			</span>
		</div>
	);
};

function App() {
	useEffect(() => {
		return initTheme();
	}, []);

	const [time, setTime] = useState("");
	const [isHovered, setIsHovered] = useState(false);
	// Expanded into a panel by a click. Hover alone only peeks.
	const [isOpen, setIsOpen] = useState(false);
	const isOpenRef = useRef(false);
	isOpenRef.current = isOpen;
	const [isReady, setIsReady] = useState(false);
	const [scale, setScale] = useState(() =>
		parseFloat(localStorage.getItem("bloom-scale") || "1.0")
	);
	const [timeFormat24h, setTimeFormat24h] = useState(
		() => localStorage.getItem("bloom-time-format-24h") === "true"
	);

	const [batteryLevel, setBatteryLevel] = useState(100);
	const [isCharging, setIsCharging] = useState(false);
	// Fetched when the pointer reaches the battery widget, for its tooltip.
	const [batteryDetails, setBatteryDetails] = useState<BatteryDetails | null>(null);
	// The status widget whose tooltip is open, the side of the pill it hangs
	// from, and the distance from the widget to just past that edge.
	const [statusTooltip, setStatusTooltip] = useState<{
		id: string;
		side: "below" | "left" | "right";
		offset: number;
	} | null>(null);
	const statusTooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Width the hovered status strip needs so neither side runs into the clock.
	const [statusFitWidth, setStatusFitWidth] = useState(0);
	const [showPowerPulse, setShowPowerPulse] = useState(false);
	const [showLowBatteryPulse, setShowLowBatteryPulse] = useState(false);
	const [lowBatteryThreshold, setLowBatteryThreshold] = useState(() =>
		parseInt(localStorage.getItem("bloom-low-battery-threshold") || "20")
	);
	const prevChargingRef = useRef<boolean | null>(null);
	const powerPulseTimeoutRef = useRef<any>(null);
	const lowBatteryPulseShownRef = useRef<boolean>(false);

	const [eventPeek, setEventPeek] = useState(false);
	const eventPeekTimeoutRef = useRef<any>(null);
	const updatePulseTimerRef = useRef<any>(null);
	const triggerEventPeek = useCallback((duration = 3000) => {
		setEventPeek(true);
		if (eventPeekTimeoutRef.current) clearTimeout(eventPeekTimeoutRef.current);
		eventPeekTimeoutRef.current = setTimeout(() => setEventPeek(false), duration);
	}, []);

	const [notchMode, setNotchMode] = useState(() => {
		const raw = localStorage.getItem("bloom-notch-mode") || "fixed";
		if (raw === "auto-hide") return "smart";
		return raw;
	});

	useEffect(() => {
		if (isReady && prevChargingRef.current !== null && prevChargingRef.current !== isCharging) {
			setShowPowerPulse(true);
			if (notchMode === "peek") triggerEventPeek(4000);
			if (powerPulseTimeoutRef.current) clearTimeout(powerPulseTimeoutRef.current);
			powerPulseTimeoutRef.current = setTimeout(() => {
				setShowPowerPulse(false);
			}, 4000);
		}
		prevChargingRef.current = isCharging;
	}, [isCharging, isReady, notchMode, triggerEventPeek]);

	useEffect(() => {
		// Trigger pulse when dropping below threshold while discharging
		if (
			isReady &&
			batteryLevel <= lowBatteryThreshold &&
			!isCharging &&
			!lowBatteryPulseShownRef.current
		) {
			setShowLowBatteryPulse(true);
			if (notchMode === "peek") triggerEventPeek(5000);
			lowBatteryPulseShownRef.current = true;
			setTimeout(() => setShowLowBatteryPulse(false), 5000);
		}

		// Reset the "shown" state if battery is charged or threshold is lowered
		if (isCharging || batteryLevel > lowBatteryThreshold) {
			lowBatteryPulseShownRef.current = false;
		}
	}, [batteryLevel, isCharging, lowBatteryThreshold, isReady, notchMode, triggerEventPeek]);

	// Weather state (managed by useWeather hook)

	// Media state
	const [isPlaying, setIsPlaying] = useState(false);
	const [mediaInfo, setMediaInfo] = useState<MediaInfo>({
		title: "",
		artist: "",
		is_playing: false,
		has_media: false
	});
	const [albumArtUrl, setAlbumArtUrl] = useState<string | null>(null);
	const [albumArtKey, setAlbumArtKey] = useState(0);
	const [volume, setVolume] = useState(0.5);
	const [isMuted, setIsMuted] = useState(false);
	// Sliders show 0 while muted, matching the overlay HUD.
	const displayVolume = isMuted ? 0 : volume;
	// Null until the first successful fetch so the pill can't flash a wrong
	// default on startup.
	const [wifiStatus, setWifiStatus] = useState<WifiStatus | null>(null);
	const wifiEnabled = wifiStatus?.enabled ?? false;
	const wifiConnected = wifiStatus?.connected ?? false;
	const [bluetoothEnabled, setBluetoothEnabled] = useState(true);
	// Names of connected Bluetooth devices, for the controls tile.
	const [btConnectedNames, setBtConnectedNames] = useState<string[]>([]);
	const [batterySaverEnabled, setBatterySaverEnabled] = useState(false);
	const [currentBrightness, setCurrentBrightness] = useState(50);
	const previousVolume = useRef(0.5);
	const previousBrightness = useRef(50);
	const [calendarMonth, setCalendarMonth] = useState(() => {
		const now = new Date();
		return new Date(now.getFullYear(), now.getMonth(), 1);
	});

	// System metrics for status widgets
	const [cpuUsage, setCpuUsage] = useState(0);
	const [ramUsage, setRamUsage] = useState(0);
	const [diskSpace, setDiskSpace] = useState(0);
	const [netUpSpeed, setNetUpSpeed] = useState(0);
	const [netDownSpeed, setNetDownSpeed] = useState(0);
	const [statusWidgets, setStatusWidgets] = useState<WidgetConfig>({
		left: ["weather"],
		right: ["battery"]
	});

	const [windowLabel, setWindowLabel] = useState<string>("");
	useEffect(() => {
		setWindowLabel(getCurrentWebviewWindow().label);
	}, []);

	// Update state
	const [updateAvailable, setUpdateAvailable] = useState(false);
	const [showUpdateIndicator, setShowUpdateIndicator] = useState(
		() => localStorage.getItem("bloom-show-update-indicator") !== "false"
	);
	const [showUpdatePulse, setShowUpdatePulse] = useState(false);

	useEffect(() => {
		if (windowLabel !== "main") return;

		let unlisten: (() => void) | undefined;
		let disposed = false;

		listen<UpdateCheckResult>("update-available", (event) => {
			setUpdateAvailable(event.payload.available);
			if (!event.payload.available) {
				setShowUpdatePulse(false);
				if (updatePulseTimerRef.current) clearTimeout(updatePulseTimerRef.current);
				return;
			}
			setShowUpdatePulse(true);
			if (notchMode === "peek") triggerEventPeek(6000);
			if (updatePulseTimerRef.current) clearTimeout(updatePulseTimerRef.current);
			updatePulseTimerRef.current = setTimeout(() => {
				setShowUpdatePulse(false);
			}, 6000);
		}).then((fn) => {
			if (disposed) fn();
			else unlisten = fn;
		});

		invoke<UpdateCheckResult>("get_update_state")
			.then((state) => {
				// Only restore a badge; clearing is left to check results so a
				// late mount read cannot race an "update-available" event.
				if (state.available) setUpdateAvailable(true);
			})
			.catch((e) => console.error("Failed to read update state:", e));

		return () => {
			disposed = true;
			unlisten?.();
			if (updatePulseTimerRef.current) clearTimeout(updatePulseTimerRef.current);
		};
	}, [windowLabel, notchMode, triggerEventPeek]);

	// Remote announcement shown as a persistent notch card until dismissed.
	const {
		announcement,
		dismissed: announcementDismissed,
		dismiss: dismissAnnouncement
	} = useAnnouncement();
	const [deviceAlert, setDeviceAlert] = useState<DeviceAlert | null>(null);
	// Each connected earbud's own levels, as last reported, for Connected devices.
	const [budsById, setBudsById] = useState<Record<string, BudsBattery>>({});
	// The height the Connected devices panel's content needs; the open notch
	// follows it up to DEVICES_MAX_HEIGHT, past which the list scrolls.
	const [devicesContentHeight, setDevicesContentHeight] = useState(DEVICES_MAX_HEIGHT);
	const devicesPanelHeight = Math.min(DEVICES_MAX_HEIGHT, Math.max(DEVICES_MIN_HEIGHT, devicesContentHeight));
	// True from an alert appearing until its exit animation has finished, so
	// the clock row only comes back once the alert has faded out.
	const [deviceAlertOnScreen, setDeviceAlertOnScreen] = useState(false);
	const deviceAlertRef = useRef<DeviceAlert | null>(null);
	deviceAlertRef.current = deviceAlert;
	const deviceAlertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (deviceAlertTimerRef.current) clearTimeout(deviceAlertTimerRef.current);
		},
		[]
	);
	const announcementShownRef = useRef<string | null>(null);
	const announcementOpen = !!announcement && !announcementDismissed;
	const announcementOpenRef = useRef(false);
	announcementOpenRef.current = announcementOpen;

	const [isVisible, setIsVisible] = useState(true);
	const [isImpacted, setIsImpacted] = useState(false);
	const [isExpanded, setIsExpanded] = useState(false);
	const [startupAnimating, setStartupAnimating] = useState(false);

	const [dockMode, setDockMode] = useState(() => {
		const raw = localStorage.getItem("bloom-dock-mode") || "smart";
		if (raw === "auto-hide") return "smart";
		return raw;
	});
	const [dockEnabled, setDockEnabled] = useState(
		() => localStorage.getItem("bloom-dock-enabled") !== "false"
	);
	const [isNotchHovered, setIsNotchHovered] = useState(false);

	const [isEdgeHovered, setIsEdgeHovered] = useState(false);
	const [isOverlapped, setIsOverlapped] = useState(false);
	const [interactionState, setInteractionState] = useState<"active" | "grace" | "none">("none");
	const bloomRef = useRef<HTMLDivElement>(null);
	// Measured to fit the hovered status strip; see statusFitWidth.
	const leftWidgetsRef = useRef<HTMLDivElement>(null);
	const rightWidgetsRef = useRef<HTMLDivElement>(null);
	const timeCenterRef = useRef<HTMLDivElement>(null);
	const musicBubbleRef = useRef<HTMLButtonElement>(null);
	const shelfBubbleRef = useRef<HTMLButtonElement>(null);
	const clipboardBubbleRef = useRef<HTMLButtonElement>(null);
	const notificationBubbleRef = useRef<HTMLButtonElement>(null);
	const [activeNotification, setActiveNotification] = useState<AppNotification | null>(null);
	const [notificationAlertOnScreen, setNotificationAlertOnScreen] = useState(false);
	const [unreadNotificationCount, setUnreadNotificationCount] = useState(0);
	const notificationAlertTimerRef = useRef<any>(null);
	const notificationQueueRef = useRef<AppNotification[]>([]);
	const activeNotificationRef = useRef<AppNotification | null>(null);
	activeNotificationRef.current = activeNotification;
	const [notificationHistory, setNotificationHistory] = useState<AppNotification[]>(() => {
		try {
			const stored = localStorage.getItem("bloom-notification-history");
			return stored ? JSON.parse(stored) : [];
		} catch {
			return [];
		}
	});
	const shelfHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const clipboardHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const notificationHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [clipboardItems, setClipboardItems] = useState<ClipboardItem[]>([]);
	const [copiedId, setCopiedId] = useState<string | null>(null);
	const [zoomedImageItem, setZoomedImageItem] = useState<ClipboardItem | null>(null);
	const [imageZoomLevel, setImageZoomLevel] = useState(1);
	const reportNotchRect = useRef<() => void>(() => {});
	// The pill's target box in window CSS px, and the sender that applies the
	// notch window's region (holding earlier regions while it shrinks).
	const pillTargetRef = useRef<RegionRect | null>(null);
	const sendNotchRegion = useMemo(
		() =>
			createRegionSender((rects) => {
				invoke("set_window_region", { rects }).catch(() => {});
			}),
		[]
	);

	// Recomputes the notch window's region from the pill's target box and the
	// floating parts drawn around it, and sends it if it changed. Reads only
	// refs and the DOM, so it is safe to call from any callback.
	const updateNotchRegion = () => {
		const wanted: RegionRect[] = [];
		if (pillTargetRef.current) wanted.push(pillTargetRef.current);
		// Each floating part, padded to cover what it paints outside its box: a
		// tooltip card's shadow reaches 20px out plus a 6px drop, a bubble's
		// glow less, and the screen corners nothing.
		wanted.push(
			...measureElements([
				[".activity-bubble", 16],
				[".status-tooltip", 28],
				[".screen-corner", 0]
			])
		);
		sendNotchRegion(wanted);
	};
	const [systemSettingsReady, setSystemSettingsReady] = useState(false);
	const [waitForStartupSplash, setWaitForStartupSplash] = useState(false);
	const initialSystemSyncDone = useRef(false);
	const splashDone = useRef(false);
	const systemSyncQueue = useRef<Promise<void>>(Promise.resolve());
	const appliedDock = useRef<{ enabled: boolean; mode: string } | null>(null);
	const appliedNotchMode = useRef<string | null>(null);

	const isAnyInteraction = isHovered || isNotchHovered || isEdgeHovered;
	const isHidden =
		!startupAnimating &&
		!deviceAlertOnScreen &&
		!notificationAlertOnScreen &&
		((notchMode === "smart" && isOverlapped && interactionState === "none") ||
			(notchMode === "peek" && interactionState === "none" && !eventPeek));

	useEffect(() => {
		if (isAnyInteraction) {
			setInteractionState("active");
		} else if (interactionState !== "none") {
			setInteractionState("grace");
			const timer = setTimeout(() => setInteractionState("none"), 800);
			return () => clearTimeout(timer);
		}
	}, [isAnyInteraction]);

	useEffect(() => {
		if (windowLabel === "main") {
			invoke("set_notch_hovered", { hovered: isNotchHovered }).catch(() => {});
		}
	}, [isNotchHovered, windowLabel]);

	// Tell the backend whether the notch is actually on screen so a hidden
	// notch (smart/peek mode) stays click-through instead of swallowing clicks
	// in its footprint.
	useEffect(() => {
		if (windowLabel === "main") {
			invoke("set_notch_visible", { visible: isVisible && !isHidden }).catch(() => {});
		}
	}, [isVisible, isHidden, windowLabel]);

	useEffect(() => {
		const updateRect = () => {
			if (bloomRef.current && windowLabel === "main") {
				// Activity bubbles sit beside the pill and must stay clickable too.
				const rects = [bloomRef.current, musicBubbleRef.current, shelfBubbleRef.current, clipboardBubbleRef.current, notificationBubbleRef.current]
					.filter((el): el is NonNullable<typeof el> => el !== null)
					.map((el) => el.getBoundingClientRect());
				const targetW = getDynamicWidth();
				const targetH = getDynamicHeight();
				const targetLeft = (window.innerWidth - targetW) / 2;
				const targetRight = targetLeft + targetW;
				const targetTop = 0;
				const targetBottom = targetH;

				const left = Math.min(targetLeft, ...rects.map((r) => r.left));
				const top = Math.min(targetTop, ...rects.map((r) => r.top));
				const right = Math.max(targetRight, ...rects.map((r) => r.right));
				const bottom = Math.max(targetBottom, ...rects.map((r) => r.bottom));
				invoke("update_notch_rect", {
					rect: {
						x: Math.round(left),
						y: Math.round(top),
						width: Math.round(right - left),
						height: Math.round(bottom - top)
					}
				}).catch(() => {});
				// Bubbles finishing their entrance land here too.
				updateNotchRegion();
			}
		};
		reportNotchRect.current = updateRect;

		updateRect();
		window.addEventListener("resize", updateRect);
		const observer = new ResizeObserver(updateRect);
		if (bloomRef.current) observer.observe(bloomRef.current);

		return () => {
			window.removeEventListener("resize", updateRect);
			observer.disconnect();
		};
	}, [isExpanded, isHidden, windowLabel, scale]);

	useEffect(() => {
		if (!windowLabel) return;

		// Only animate the main top-bar
		if (windowLabel !== "main") {
			setIsReady(true);
			setIsImpacted(true);
			setIsExpanded(true);
			return;
		}

		const proceedWithStartup = () => {
			const checkVisibility = async () => {
				try {
					const win = getCurrentWebviewWindow();
					let visible = await win.isVisible();
					if (!visible) {
						await win.show().catch(() => {});
						visible = await win.isVisible();
					}
					if (visible) {
						setStartupAnimating(true);
						setIsReady(true);
						// The window is shown here; WebView2 may only create its
						// render child now, so refresh the drop targets.
						invoke("setup_shelf_drop").catch(() => {});
						setTimeout(() => {
							setIsImpacted(true);
							setIsExpanded(true);
						}, 240);
						setTimeout(() => setStartupAnimating(false), 1500);
						return true;
					}
				} catch (e) {}
				return false;
			};

			const interval = setInterval(async () => {
				if (await checkVisibility()) clearInterval(interval);
			}, 100);

			checkVisibility();
			return interval;
		};

		// Mirror Overlay.tsx's splash decision so we only wait when a splash will actually fire.
		// Overlay always emits splash-done, but on a normal relaunch it emits it near-instantly
		// (after one async getVersion() call) — before this listener would be registered.
		// By making the same decision here we avoid a race and avoid any unnecessary delay.
		const firstRun = localStorage.getItem("bloom-first-run") === null;
		const storedVersion = localStorage.getItem("bloom-app-version");

		const waitForSplash = () => {
			// Splash is definitely coming — register listener now (2800ms animation gives us plenty of time)
			let started = false;
			let interval: any;
			const unlistenSplash = listen("splash-done", () => {
				if (started) return;
				started = true;
				interval = proceedWithStartup();
				unlistenSplash.then((fn) => fn());
			});
			const safetyTimer = setTimeout(() => {
				if (started) return;
				started = true;
				interval = proceedWithStartup();
				unlistenSplash.then((fn) => fn());
			}, 6000);
			return () => {
				clearTimeout(safetyTimer);
				if (interval) clearInterval(interval);
				unlistenSplash.then((fn) => fn());
			};
		};

		if (firstRun || storedVersion === null) {
			// Splash is definitely showing — wait for it
			return waitForSplash();
		}

		// Has a version key — need async check to know if version changed
		let interval: any;
		getVersion()
			.then((currentVersion) => {
				if (storedVersion !== currentVersion) {
					// Version changed — splash is coming, wait for it
					// (splash takes 2800ms so there's plenty of time to register the listener)
					waitForSplash();
				} else {
					// Same version — no splash, start immediately
					interval = proceedWithStartup();
				}
			})
			.catch(() => {
				interval = proceedWithStartup();
			});
		return () => {
			if (interval) clearInterval(interval);
		};
	}, [windowLabel]);

	// Settings state
	const [settingsWeatherEnabled, setSettingsWeatherEnabled] = useState(
		() => localStorage.getItem("bloom-weather-enabled") !== "false"
	);
	const [calendarMondayFirst, setCalendarMondayFirst] = useState(
		() => localStorage.getItem("bloom-calendar-monday-first") === "true"
	);
	const [settingsCalendarEnabled, setSettingsCalendarEnabled] = useState(
		() => localStorage.getItem("bloom-calendar-enabled") !== "false"
	);
	// Which panels the notch shows. Calendar and Controls are on by default;
	// Connected devices (and panels added later) are opt-in.
	const [settingsControlsPanelEnabled, setSettingsControlsPanelEnabled] = useState(
		() => localStorage.getItem("bloom-notch-command-center-enabled") !== "false"
	);
	const [settingsDevicesPanelEnabled, setSettingsDevicesPanelEnabled] = useState(
		() => localStorage.getItem("bloom-notch-devices-enabled") === "true"
	);
	const connectedDevices = useConnectedDevices(windowLabel === "main" && settingsDevicesPanelEnabled);
	const [settingsTimerSoundEnabled, setSettingsTimerSoundEnabled] = useState(
		() => localStorage.getItem("bloom-timer-sound-enabled") !== "false"
	);
	const [settingsMusicModeEnabled, setSettingsMusicModeEnabled] = useState(
		() => localStorage.getItem("bloom-music-mode-enabled") !== "false"
	);
	const [rememberPanelEnabled, setRememberPanelEnabled] = useState(
		() => (localStorage.getItem("bloom-notch-remember-panel") ??
			localStorage.getItem("bloom-notch-click-to-open")) !== "false"
	);
	const rememberPanelEnabledRef = useRef(rememberPanelEnabled);
	rememberPanelEnabledRef.current = rememberPanelEnabled;
	const [defaultPanel, setDefaultPanel] = useState<NotchPanel>(() =>
		asNotchPanel(localStorage.getItem("bloom-notch-default-panel")) ?? "calendar"
	);
	// The panel the open notch was last left on. Opening the notch returns to it,
	// across restarts too (bloom-notch-last-panel).
	const [lastPanel, setLastPanel] = useState<NotchPanel | null>(() =>
		asNotchPanel(localStorage.getItem("bloom-notch-last-panel"))
	);
	const [settingsMusicCompactNotch, setSettingsMusicCompactNotch] = useState(
		() => localStorage.getItem("bloom-music-compact-notch") !== "false"
	);
	const [shelfPersist, setShelfPersist] = useState(
		() => localStorage.getItem("bloom-shelf-persist") !== "false"
	);
	const [settingsVisualizerEnabled, setSettingsVisualizerEnabled] = useState(
		() => localStorage.getItem("bloom-visualizer-enabled") !== "false"
	);
	const [settingsAlbumArtEnabled, setSettingsAlbumArtEnabled] = useState(
		() => localStorage.getItem("bloom-media-album-art-enabled") !== "false"
	);
	const [settingsAmbienceEnabled, setSettingsAmbienceEnabled] = useState(
		() => localStorage.getItem("bloom-media-ambience-enabled") !== "false"
	);
	const [settingsCompactGlowEnabled, setSettingsCompactGlowEnabled] = useState(
		() => localStorage.getItem("bloom-media-compact-glow-enabled") !== "false"
	);
	const [settingsCornersEnabled, setSettingsCornersEnabled] = useState(
		() => localStorage.getItem("bloom-corners-enabled") === "true"
	);
	const [edgeShineEnabled, setEdgeShineEnabled] = useState(
		() => localStorage.getItem("bloom-edge-shine-enabled") !== "false"
	);
	const [mediaLayout, setMediaLayout] = useState<"classic" | "compact">(
		() => (localStorage.getItem("bloom-media-layout") as "classic" | "compact") || "classic"
	);
	const [compactVolumeExpanded, setCompactVolumeExpanded] = useState(false);

	// Weather hook
	const {
		temperature,
		weatherCondition,
		weatherIcon: WeatherIcon,
		cityName,
		tempUnit
	} = useWeather(settingsWeatherEnabled);

	useEffect(() => {
		if (!windowLabel) return;
		let cancelled = false;

		invoke("load_settings")
			.then(async (settings: any) => {
				if (await reloadIfMirrorWasStale(settings)) return;
				if (cancelled) return;
				const getVal = (key: string, fallback: string | null = null) => {
					const val = settings[key];
					if (val !== undefined && val !== null) return String(val);
					const local = localStorage.getItem(key);
					if (local !== null) return local;
					return fallback;
				};

				setSettingsWeatherEnabled(getVal("bloom-weather-enabled", "true") !== "false");
				setSettingsCalendarEnabled(getVal("bloom-calendar-enabled", "true") !== "false");
				setCalendarMondayFirst(getVal("bloom-calendar-monday-first", "false") === "true");
				setSettingsControlsPanelEnabled(
					getVal("bloom-notch-command-center-enabled", "true") !== "false"
				);
				setSettingsDevicesPanelEnabled(getVal("bloom-notch-devices-enabled", "false") === "true");
				setSettingsTimerSoundEnabled(getVal("bloom-timer-sound-enabled", "true") !== "false");
				setSettingsMusicModeEnabled(getVal("bloom-music-mode-enabled", "true") !== "false");
				setRememberPanelEnabled(
					(getVal("bloom-notch-remember-panel") ?? getVal("bloom-notch-click-to-open", "true")) !== "false"
				);
				setDefaultPanel(asNotchPanel(getVal("bloom-notch-default-panel")) ?? "calendar");
				setShelfPersist(getVal("bloom-shelf-persist", "true") !== "false");
				setSettingsMusicCompactNotch(getVal("bloom-music-compact-notch", "true") !== "false");
				setLastPanel(asNotchPanel(getVal("bloom-notch-last-panel")));
				const viz =
					getVal("bloom-media-visualizer-enabled") ?? getVal("bloom-visualizer-enabled", "true");
				setSettingsVisualizerEnabled(viz !== "false");
				setSettingsAlbumArtEnabled(getVal("bloom-media-album-art-enabled", "true") !== "false");
				setSettingsAmbienceEnabled(getVal("bloom-media-ambience-enabled", "true") !== "false");
				setSettingsCompactGlowEnabled(
					getVal("bloom-media-compact-glow-enabled", "true") !== "false"
				);
				setSettingsCornersEnabled(getVal("bloom-corners-enabled", "false") === "true");
				setEdgeShineEnabled(getVal("bloom-edge-shine-enabled", "true") !== "false");
				setTimeFormat24h(getVal("bloom-time-format-24h") === "true");

				const thresholdStr = getVal("bloom-low-battery-threshold", "20");
				if (thresholdStr) setLowBatteryThreshold(parseInt(thresholdStr as string));

				const nMode = getVal("bloom-notch-mode", "fixed");
				if (nMode) {
					const mapped = nMode === "auto-hide" ? "smart" : nMode;
					setNotchMode(mapped);
				}

				if (windowLabel === "main") {
					const firstRun = localStorage.getItem("bloom-first-run") === null;
					if (firstRun) {
						import("@tauri-apps/plugin-autostart").then(({ enable, isEnabled }) => {
							isEnabled().then((enabled) => {
								if (!enabled) enable().catch(() => {});
							});
						});
						localStorage.setItem("bloom-first-run", "done");
					}
					const rawDockMode = getVal("bloom-dock-mode", "smart") as string;
					const dockMode = rawDockMode === "auto-hide" ? "smart" : rawDockMode;
					setDockMode(dockMode);
					setDockEnabled(getVal("bloom-dock-enabled", "true") === "true");
					const storedVersion = localStorage.getItem("bloom-app-version");
					let waitForSplash = firstRun || storedVersion === null;
					if (!waitForSplash) {
						try {
							waitForSplash = storedVersion !== (await getVersion());
						} catch {
							// Version lookup is optional; continue startup without a splash.
						}
					}
					if (cancelled) return;
					setWaitForStartupSplash(waitForSplash);
					setSystemSettingsReady(true);
				}

				const scaleVal = getVal("bloom-scale");
				if (scaleVal !== null) setScale(parseFloat(scaleVal));

				const widgetsVal = getVal("bloom-status-widgets");
				if (widgetsVal) {
					try {
						const parsed = JSON.parse(widgetsVal);
						if (parsed && Array.isArray(parsed.left) && Array.isArray(parsed.right)) {
							setStatusWidgets(parsed);
						}
					} catch {}
				}
			})
			.catch((error) => {
				console.error(error);
				if (!cancelled && windowLabel === "main") setSystemSettingsReady(true);
			});
		return () => {
			cancelled = true;
		};
	}, [windowLabel]); // eslint-disable-line react-hooks/exhaustive-deps

	useEffect(() => {
		// Disable context menu globally
		const preventContext = (e: MouseEvent) => e.preventDefault();
		document.addEventListener("contextmenu", preventContext);

		const unlistenVisibility = listen<boolean>("visibility-change", (event) => {
			setIsVisible(event.payload);
		});

		const unlistenNotchOverlap = listen<boolean>("notch-overlap", (event) => {
			setIsOverlapped(event.payload);
		});

		const unlistenNotchEdgeHover = listen<boolean>("notch-edge-hover", (event) => {
			setIsEdgeHovered(event.payload);
		});

		// The backend emits this when the window flips to click-through while
		// the webview still thinks the pointer is inside the notch (it cannot
		// receive the mouseleave once the window is click-through).
		const unlistenNotchPointerLeft = listen("notch-pointer-left", () => {
			releaseNotchHover();
		});

		return () => {
			unlistenVisibility.then((f) => f());
			unlistenNotchOverlap.then((f) => f());
			unlistenNotchEdgeHover.then((f) => f());
			unlistenNotchPointerLeft.then((f) => f());
			document.removeEventListener("contextmenu", preventContext);
		};
	}, [windowLabel]);

	// Settings sync — consolidated dispatch for all settings events
	useSettingsSync(
		{
			"bloom-weather-enabled": setSettingsWeatherEnabled,
			"bloom-calendar-enabled": setSettingsCalendarEnabled,
			"bloom-calendar-monday-first": setCalendarMondayFirst,
			"bloom-notch-command-center-enabled": setSettingsControlsPanelEnabled,
			"bloom-notch-devices-enabled": setSettingsDevicesPanelEnabled,
			"bloom-timer-sound-enabled": setSettingsTimerSoundEnabled,
			"bloom-music-mode-enabled": setSettingsMusicModeEnabled,
			"bloom-notch-remember-panel": setRememberPanelEnabled,
			"bloom-notch-default-panel": (v: unknown) =>
				setDefaultPanel(asNotchPanel(v) ?? "calendar"),
			"bloom-shelf-persist": setShelfPersist,
			"bloom-music-compact-notch": setSettingsMusicCompactNotch,
			"bloom-notch-last-panel": (v: unknown) => setLastPanel(asNotchPanel(v)),
			"bloom-media-visualizer-enabled": setSettingsVisualizerEnabled,
			"bloom-visualizer-enabled": setSettingsVisualizerEnabled,
			"bloom-media-album-art-enabled": setSettingsAlbumArtEnabled,
			"bloom-media-ambience-enabled": setSettingsAmbienceEnabled,
			"bloom-media-compact-glow-enabled": setSettingsCompactGlowEnabled,
			"bloom-media-layout": setMediaLayout,
			"bloom-corners-enabled": setSettingsCornersEnabled,
			"bloom-edge-shine-enabled": setEdgeShineEnabled,
			"bloom-scale": setScale,
			"bloom-low-battery-threshold": setLowBatteryThreshold,
			"bloom-dock-enabled": setDockEnabled,
			"bloom-dock-mode": setDockMode,
			"bloom-notch-mode": setNotchMode,
			"bloom-status-widgets": (value) => {
				try {
					const parsed = JSON.parse(value);
					if (parsed && Array.isArray(parsed.left) && Array.isArray(parsed.right)) {
						setStatusWidgets(parsed);
					}
				} catch {}
			},
			"bloom-show-update-indicator": (value) => setShowUpdateIndicator(String(value) === "true"),
			"bloom-time-format-24h": setTimeFormat24h
		},
		[windowLabel]
	);

	// One owner applies the latest window settings. Superseded splash timers and
	// retries are cancelled; an in-flight command finishes before the new state
	// is applied, so an old startup retry cannot overwrite a user change.
	useEffect(() => {
		if (windowLabel !== "main" || !systemSettingsReady) return;

		let cancelled = false;
		let started = false;
		let attempts = 0;
		let startTimer: number | undefined;
		let splashTimer: number | undefined;
		let retryTimer: number | undefined;
		let settleTimer: number | undefined;
		let unlistenSplash: (() => void) | undefined;

		const reconcile = () => {
			systemSyncQueue.current = systemSyncQueue.current
				.catch(() => {})
				.then(async () => {
					if (cancelled) return;
					try {
						if (dockEnabled) {
							if (!appliedDock.current?.enabled) {
								await invoke("init_dock", { mode: dockMode });
								appliedDock.current = { enabled: true, mode: dockMode };
							} else if (appliedDock.current.mode !== dockMode) {
								await invoke("change_dock_mode", { mode: dockMode });
								appliedDock.current = { enabled: true, mode: dockMode };
							}
						} else if (appliedDock.current?.enabled !== false) {
							await invoke("toggle_dock", { enable: false });
							appliedDock.current = { enabled: false, mode: dockMode };
						}
						if (cancelled) return;
						if (appliedNotchMode.current !== notchMode) {
							await invoke("change_notch_mode", { mode: notchMode });
							appliedNotchMode.current = notchMode;
						}
						if (cancelled) return;
						await invoke("sync_appbar");
						if (cancelled) return;
						const wasInitialSync = !initialSystemSyncDone.current;
						initialSystemSyncDone.current = true;
						if (wasInitialSync) {
							settleTimer = window.setTimeout(() => {
								if (!cancelled) {
									systemSyncQueue.current = systemSyncQueue.current
										.catch(() => {})
										.then(() => invoke<void>("sync_appbar"))
										.catch((error) => console.error("AppBar settle failed", error));
								}
							}, 1000);
						}
					} catch (error) {
						console.error("Window reconciliation failed", error);
						if (!cancelled && attempts++ < 1) {
							retryTimer = window.setTimeout(reconcile, 1000);
						}
					}
				});
		};

		const start = () => {
			if (cancelled || started) return;
			started = true;
			splashDone.current = true;
			if (splashTimer !== undefined) window.clearTimeout(splashTimer);
			unlistenSplash?.();
			startTimer = window.setTimeout(reconcile, initialSystemSyncDone.current ? 0 : 400);
		};

		if (waitForStartupSplash && !splashDone.current && !initialSystemSyncDone.current) {
			void listen("splash-done", start)
				.then((unlisten) => {
					if (cancelled || started) unlisten();
					else unlistenSplash = unlisten;
				})
				.catch(() => start());
			splashTimer = window.setTimeout(start, 6000);
		} else {
			start();
		}

		return () => {
			cancelled = true;
			for (const timer of [startTimer, splashTimer, retryTimer, settleTimer]) {
				if (timer !== undefined) window.clearTimeout(timer);
			}
			unlistenSplash?.();
		};
	}, [windowLabel, systemSettingsReady, waitForStartupSplash, dockEnabled, dockMode, notchMode]);

	// Bloom mode state: 'music', 'calendar', 'command-center', 'announcement', 'shelf', or 'status'
	const [bloomMode, setBloomMode] = useState<BloomMode>("status");

	// Shelf: files and selected text stashed in the notch via drag-and-drop.
	// Files are stored as plain paths (references, never copies). Session-scoped
	// by default; the bloom-shelf-persist setting keeps items across restarts.
	const [shelfItems, setShelfItems] = useState<ShelfItem[]>(() => {
		if (localStorage.getItem("bloom-shelf-persist") !== "true") return [];
		try {
			const saved = localStorage.getItem("bloom-shelf-items");
			const parsed = saved ? JSON.parse(saved) : [];
			if (!Array.isArray(parsed)) return [];
			return parsed
				.filter((i): i is ShelfItem => {
					if (typeof i?.id !== "string" || typeof i?.name !== "string") return false;
					// Items stored before text support have no `type`; treat as files.
					if (i.type === "text") return typeof i.text === "string";
					return typeof i.path === "string";
				})
				.map((i) => ({ ...i, type: i.type === "text" ? "text" : "file" }));
		} catch {
			return [];
		}
	});
	useEffect(() => {
		try {
			if (shelfPersist) {
				localStorage.setItem("bloom-shelf-items", JSON.stringify(shelfItems));
			} else {
				localStorage.removeItem("bloom-shelf-items");
			}
		} catch {
			/* storage full or unavailable — shelf just won't persist */
		}
	}, [shelfItems, shelfPersist]);

	useEffect(() => {
		invoke<ClipboardItem[]>("get_clipboard_history")
			.then((items) => {
				if (Array.isArray(items)) setClipboardItems(items);
			})
			.catch(() => {});

		const unlisten = listen<ClipboardItem[]>("clipboard-update", (event) => {
			if (Array.isArray(event.payload)) {
				setClipboardItems(event.payload);
			}
		});

		return () => {
			unlisten.then((f) => f()).catch(() => {});
			if (shelfHoverTimer.current) clearTimeout(shelfHoverTimer.current);
			if (clipboardHoverTimer.current) clearTimeout(clipboardHoverTimer.current);
			if (notificationHoverTimer.current) clearTimeout(notificationHoverTimer.current);
		};
	}, []);

	// Drop file references whose files are gone (moved/deleted/drive unplugged)
	// once at startup, so a persisted shelf does not accumulate dead entries.
	// Text items are always kept.
	const shelfPrunedRef = useRef(false);
	useEffect(() => {
		if (shelfPrunedRef.current) return;
		shelfPrunedRef.current = true;
		const filePaths = shelfItems
			.filter((i) => i.type === "file" && i.path)
			.map((i) => i.path as string);
		if (filePaths.length === 0) return;
		invoke<string[]>("shelf_prune", { paths: filePaths })
			.then((existing) => {
				const alive = new Set(existing);
				setShelfItems((prev) => {
					const kept = prev.filter(
						(i) => i.type !== "file" || (i.path !== undefined && alive.has(i.path))
					);
					return kept.length === prev.length ? prev : kept;
				});
			})
			.catch(() => {});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Previews are generated lazily per path and cached. Images, PDFs, Office
	// files with a saved thumbnail, and anything Windows can thumbnail (videos,
	// folders...) show a picture; documents and text files show their opening
	// text; the rest fall back to an icon for their type. Text items render
	// their content.
	const [shelfThumbs, setShelfThumbs] = useState<Record<string, ShelfPreview>>({});
	const shelfThumbPending = useRef<Set<string>>(new Set());
	useEffect(() => {
		for (const item of shelfItems) {
			if (item.type !== "file" || !item.path) continue;
			const path = item.path;
			if (shelfThumbs[path] !== undefined || shelfThumbPending.current.has(path)) continue;
			shelfThumbPending.current.add(path);
			// The item may be removed while this is in flight; don't resurrect
			// a stale cache entry.
			const storeThumb = (preview: ShelfPreview) =>
				setShelfThumbs((prev) => {
					if (!shelfItemsRef.current.some((i) => i.path === path)) return prev;
					return { ...prev, [path]: preview };
				});
			invoke<ShelfPreview>("shelf_thumbnail", { path })
				.then(storeThumb)
				.catch(() => storeThumb({ thumb: null, text: null, folder: false }))
				.finally(() => shelfThumbPending.current.delete(path));
		}
	}, [shelfItems, shelfThumbs]);

	// Drop cached thumbnails for items that left the shelf so the cache cannot
	// grow without bound over a long session (each entry is a data URI).
	useEffect(() => {
		const current = new Set(shelfItems.filter((i) => i.path).map((i) => i.path as string));
		setShelfThumbs((prev) => {
			const keys = Object.keys(prev);
			if (keys.every((k) => current.has(k))) return prev;
			const next: Record<string, ShelfPreview> = {};
			for (const k of keys) {
				if (current.has(k)) next[k] = prev[k];
			}
			return next;
		});
	}, [shelfItems]);

	// Native drag preview for items without a thumbnail.
	const [shelfDragIcon, setShelfDragIcon] = useState<string | null>(null);
	useEffect(() => {
		invoke<string | null>("shelf_drag_icon")
			.then(setShelfDragIcon)
			.catch(() => {});
	}, []);

	// Picking a file back up is a drag-out gesture: press, move past a small
	// threshold, and the OS takes over the drag. A press without movement is a
	// plain click that opens the file (or copies text items).
	const shelfPointerRef = useRef<{ id: string; x: number; y: number; dragging: boolean } | null>(
		null
	);
	// Timestamp of the last drop onto the notch. A drop recorded during our
	// own drag-out means the item came back to the notch (pointer still over
	// it), which decides whether the drag cleanup clears the hover flags.
	const shelfSelfDropAtRef = useRef(0);
	// True while our own drag-out is running, so the drag-enter we receive when
	// it starts over the notch does not flash the hover outline or re-open it.
	const shelfSelfDragRef = useRef(false);
	const handleShelfPointerDown = (e: React.PointerEvent<HTMLDivElement>, item: ShelfItem) => {
		if (e.button !== 0) return;
		// Text items have no native drag-out; a click copies them.
		if (item.type !== "file" || !item.path) return;
		// The remove button must keep receiving its own click; capturing the
		// pointer on the tile would retarget it.
		if ((e.target as HTMLElement).closest(".shelf-tile-remove")) return;
		e.stopPropagation();
		e.currentTarget.setPointerCapture(e.pointerId);
		shelfPointerRef.current = { id: item.id, x: e.clientX, y: e.clientY, dragging: false };
	};
	const handleShelfPointerMove = (e: React.PointerEvent<HTMLDivElement>, item: ShelfItem) => {
		const st = shelfPointerRef.current;
		if (!st || st.id !== item.id || st.dragging) return;
		if (Math.hypot(e.clientX - st.x, e.clientY - st.y) < 6) return;
		if (!item.path) return;
		const path = item.path;
		const icon = shelfThumbs[path]?.thumb ?? shelfDragIcon;
		if (!icon) return;
		st.dragging = true;
		// Picking an item up is a deliberate act; don't let the post-drop
		// auto-close fire mid-drag.
		clearShelfCollapse();
		shelfSelfDragRef.current = true;
		const dragStartedAt = Date.now();
		startDrag({ item: [path], icon })
			.catch((err) => console.error("[shelf] drag out failed:", path, err))
			.finally(() => {
				shelfSelfDragRef.current = false;
				// A drop recorded during this drag means it landed back on the
				// notch, so the pointer is still over it. Otherwise the native
				// drag owned the pointer and the webview never saw it leave —
				// release the hover state (flags AND the resting mode) or the
				// shelf panel stays expanded. The command also makes the
				// backend re-evaluate its edge-hover state immediately.
				const droppedOnSelf = shelfSelfDropAtRef.current >= dragStartedAt;
				if (!droppedOnSelf) {
					releaseNotchHover();
					invoke("set_notch_hovered", { hovered: false }).catch(() => {});
				}
			});
	};
	const handleShelfTileClick = (e: React.MouseEvent<HTMLDivElement>, item: ShelfItem) => {
		e.stopPropagation();
		const st = shelfPointerRef.current;
		shelfPointerRef.current = null;
		// Only this tile's own drag suppresses the click; a stale flag from a
		// previous tile's drag-out must not swallow it.
		if (st && st.id === item.id && st.dragging) return;
		openShelfItem(item);
	};

	// Wheel scrolling for the shelf strip: ease towards a target instead of
	// jumping, so wheel and trackpad input both feel fluid.
	const shelfScrollTargetRef = useRef<number | null>(null);
	const shelfGridRef = useRef<HTMLDivElement>(null);
	// Whether the shelf row overflows, so it gets room for its scrollbar.
	const [shelfOverflowing, setShelfOverflowing] = useState(false);
	// Measured against the open shelf's width (380px minus its 14px side
	// padding) rather than the live one, which is still growing while the
	// notch animates open. A removed tile stays in the row until its exit
	// animation ends, so the row is measured again then.
	const measureShelfOverflow = useCallback(() => {
		const el = shelfGridRef.current;
		setShelfOverflowing(!!el && el.scrollWidth > 380 - 28 + 1);
	}, []);
	useLayoutEffect(measureShelfOverflow, [shelfItems, bloomMode, measureShelfOverflow]);
	const shelfScrollRafRef = useRef<number | null>(null);
	// The wheel scrolls the row from anywhere over the shelf view, not just
	// over the tiles. Mice that report lines instead of pixels are scaled up.
	const handleShelfWheel = (e: React.WheelEvent<HTMLDivElement>) => {
		const el = shelfGridRef.current;
		if (!el) return;
		const max = el.scrollWidth - el.clientWidth;
		if (max <= 0) return;
		const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? el.clientWidth : 1;
		const base = shelfScrollTargetRef.current ?? el.scrollLeft;
		shelfScrollTargetRef.current = Math.max(0, Math.min(max, base + (e.deltaY + e.deltaX) * unit));
		if (shelfScrollRafRef.current !== null) return;
		const step = () => {
			const target = shelfScrollTargetRef.current;
			if (target === null) {
				shelfScrollRafRef.current = null;
				return;
			}
			const diff = target - el.scrollLeft;
			if (Math.abs(diff) < 0.5) {
				el.scrollLeft = target;
				shelfScrollTargetRef.current = null;
				shelfScrollRafRef.current = null;
				return;
			}
			const before = el.scrollLeft;
			el.scrollLeft += diff * 0.22;
			// At fractional display scales a small step can round back to the
			// same position; finish the move instead of stalling short of it.
			if (el.scrollLeft === before) {
				el.scrollLeft = target;
				shelfScrollTargetRef.current = null;
				shelfScrollRafRef.current = null;
				return;
			}
			shelfScrollRafRef.current = requestAnimationFrame(step);
		};
		shelfScrollRafRef.current = requestAnimationFrame(step);
	};

	// The shelf closes itself shortly after a drop so the notch does not stay
	// expanded. Hovering it cancels the timer; leaving collapses it.
	const shelfCollapseTimer = useRef<number | null>(null);
	// What the collapsed notch shows (see collapsedMode). Refs let the drop
	// listener and the backend pointer-left event, both mounted once, act on
	// the current state.
	const restingModeRef = useRef<BloomMode>("status");
	const bloomModeRef = useRef<BloomMode>("status");
	const rememberPanelRef = useRef<(panel: NotchPanel) => void>(() => {});
	const notchPinnedRef = useRef(false);
	const releaseDeferredRef = useRef(false);

	// Shared hover-release, called on DOM hover end and when the backend
	// reports the pointer left the (now click-through) notch window. Closes an
	// open notch, remembering its panel, and returns to the resting mode.
	const releaseNotchHover = () => {
		// A view being typed into (a Wi-Fi password) keeps the notch open; the
		// release happens once it lets go, if the pointer is still away.
		if (notchPinnedRef.current) {
			releaseDeferredRef.current = true;
			return;
		}
		setIsHovered(false);
		setIsNotchHovered(false);
		setZoomedImageItem(null);
		setImageZoomLevel(1);
		if (isOpenRef.current) {
			const panel = asNotchPanel(bloomModeRef.current);
			if (panel && rememberPanelEnabledRef.current) rememberPanelRef.current(panel);
			setIsOpen(false);
		}
		setBloomMode((prev) =>
			prev === "music" ||
			prev === "command-center" ||
			prev === "calendar" ||
			prev === "status" ||
			prev === "shelf" ||
			prev === "clipboard" ||
			prev === "wifi" ||
			prev === "bluetooth" ||
			prev === "devices" ||
			prev === "notifications"
				? restingModeRef.current
				: prev
		);
	};

	const clearShelfCollapse = () => {
		if (shelfCollapseTimer.current !== null) {
			window.clearTimeout(shelfCollapseTimer.current);
			shelfCollapseTimer.current = null;
		}
	};

	const collapseShelfSoon = (delay = 1800) => {
		clearShelfCollapse();
		shelfCollapseTimer.current = window.setTimeout(() => {
			shelfCollapseTimer.current = null;
			if (bloomModeRef.current !== "shelf") return;
			setIsOpen(false);
			setBloomMode(restingModeRef.current);
		}, delay);
	};

	const removeShelfItem = (id: string) => {
		const next = shelfItems.filter((i) => i.id !== id);
		setShelfItems(next);
		if (next.length === 0 && bloomMode === "shelf") {
			// Nothing left to show: an open notch moves to the remembered panel,
			// a closed one to its resting mode, instead of an empty shelf.
			clearShelfCollapse();
			setBloomMode(isOpen ? openingPanel() : restingModeRef.current);
		}
	};

	// A full shelf never evicts silently: whatever fits is added and the rest
	// is reported. Reads through a ref so the drop listener (mounted once) sees
	// the current list.
	const shelfItemsRef = useRef<ShelfItem[]>(shelfItems);
	shelfItemsRef.current = shelfItems;
	// Tiles that were just added get an entrance animation; ones restored when
	// the panel reopens do not (the panel itself already fades in).
	const shelfNewIdsRef = useRef<Set<string>>(new Set());
	const markShelfNew = (ids: string[]) => {
		for (const id of ids) shelfNewIdsRef.current.add(id);
		window.setTimeout(() => {
			for (const id of ids) shelfNewIdsRef.current.delete(id);
		}, 900);
	};
	const [shelfNotice, setShelfNotice] = useState<string | null>(null);
	const shelfNoticeTimer = useRef<number | null>(null);
	const showShelfNotice = (message: string) => {
		setShelfNotice(message);
		if (shelfNoticeTimer.current !== null) window.clearTimeout(shelfNoticeTimer.current);
		shelfNoticeTimer.current = window.setTimeout(() => {
			shelfNoticeTimer.current = null;
			setShelfNotice(null);
		}, 2600);
	};

	const addShelfItems = (paths: string[]) => {
		if (paths.length === 0) return;
		const prev = shelfItemsRef.current;
		const existing = new Set(prev.filter((i) => i.path).map((i) => i.path));
		const fresh: ShelfItem[] = [];
		for (const p of paths) {
			if (existing.has(p)) continue;
			existing.add(p);
			fresh.push({
				id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				type: "file",
				name: p.split("\\").pop()?.split("/").pop() || p,
				path: p,
				timestamp: Date.now()
			});
		}
		if (fresh.length === 0) return;

		const room = Math.max(0, SHELF_MAX_ITEMS - prev.length);
		if (room === 0) {
			showShelfNotice(`Shelf is full (${SHELF_MAX_ITEMS}) — remove an item first`);
			return;
		}
		if (fresh.length > room) {
			showShelfNotice(`Shelf is full — added ${room} of ${fresh.length} items`);
		}
		const added = fresh.slice(0, room);
		markShelfNew(added.map((i) => i.id));
		setShelfItems([...added, ...prev]);
	};

	const addShelfText = (text: string) => {
		const prev = shelfItemsRef.current;
		if (prev.some((i) => i.type === "text" && i.text === text)) return;
		if (prev.length >= SHELF_MAX_ITEMS) {
			showShelfNotice(`Shelf is full (${SHELF_MAX_ITEMS}) — remove an item first`);
			return;
		}
		const item: ShelfItem = {
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			type: "text",
			name: text.trim().replace(/\s+/g, " ").slice(0, 48),
			text,
			timestamp: Date.now()
		};
		markShelfNew([item.id]);
		setShelfItems([item, ...prev]);
	};

	// Files open in their default app; text items are copied to the clipboard
	// so they can be pasted anywhere. A file that no longer exists is reported
	// and dropped from the shelf.
	const openShelfItem = (item: ShelfItem) => {
		if (item.type === "text") {
			if (!item.text) return;
			writeText(item.text)
				.then(() => showShelfNotice("Copied to clipboard"))
				.catch((e) => console.error("[shelf] copy failed:", e));
			return;
		}
		if (item.path) {
			const path = item.path;
			invoke("shelf_open", { path }).catch(async (e) => {
				console.error("[shelf] open failed:", path, e);
				// Only a confirmed-missing file leaves the shelf; a transient
				// failure (e.g. no association) must not remove it.
				const alive = await invoke<string[]>("shelf_prune", { paths: [path] }).catch(() => null);
				if (alive && alive.length === 0) {
					showShelfNotice("File no longer exists — removed from shelf");
					removeShelfItem(item.id);
				} else {
					showShelfNotice("Couldn't open the file");
				}
			});
		}
	};

	// Shelf drag-and-drop plumbing. The backend registers its own OLE drop
	// target (src-tauri/src/shelf.rs) because wry's target can go stale when
	// WebView2 recreates its render child; it emits the shelf-drag-* events
	// below. Drag-enter switches to the shelf panel (restoring the previous
	// mode on cancel); drop stashes the real file paths.
	const [isDragHovering, setIsDragHovering] = useState(false);
	const shelfPrevModeRef = useRef<BloomMode>("status");
	const shelfPrevOpenRef = useRef(false);
	const shelfDragActiveRef = useRef(false);
	useEffect(() => {
		let unlisteners: (() => void)[] = [];
		let cancelled = false;

		const enter = (event: { payload: { paths?: string[]; text?: string } }) => {
			// Our own drag-out starts with the cursor over the notch; ignore
			// the enter it causes instead of flashing the hover state.
			if (shelfSelfDragRef.current) return;
			console.info("[shelf] drag-enter:", event.payload.paths ?? event.payload.text);
			setIsDragHovering(true);
			const prev = bloomModeRef.current;
			if (prev === "announcement" || prev === "shelf") return;
			shelfPrevModeRef.current = prev;
			shelfPrevOpenRef.current = isOpenRef.current;
			shelfDragActiveRef.current = true;
			setIsOpen(true);
			setBloomMode("shelf");
		};
		const leave = () => {
			setIsDragHovering(false);
			if (shelfDragActiveRef.current) {
				shelfDragActiveRef.current = false;
				if (bloomModeRef.current === "shelf") {
					setIsOpen(shelfPrevOpenRef.current);
					setBloomMode(shelfPrevModeRef.current);
				}
			}
		};
		const drop = (event: { payload: { paths?: string[]; text?: string } }) => {
			setIsDragHovering(false);
			shelfDragActiveRef.current = false;
			shelfSelfDropAtRef.current = Date.now();
			const paths = event.payload.paths ?? [];
			const text = event.payload.text;
			console.info("[shelf] drop:", paths.length > 0 ? paths : text);
			if (paths.length === 0 && !text) return;
			if (paths.length > 0) addShelfItems(paths);
			if (text) addShelfText(text);
			if (bloomModeRef.current !== "announcement") {
				setIsOpen(true);
				setBloomMode("shelf");
			}
			collapseShelfSoon();
		};

		Promise.all([
			listen<{ paths?: string[]; text?: string }>("shelf-drag-enter", enter),
			listen("shelf-drag-leave", leave),
			listen<{ paths?: string[]; text?: string }>("shelf-drag-drop", drop)
		])
			.then((fns) => {
				if (cancelled) {
					fns.forEach((fn) => fn());
				} else {
					unlisteners = fns;
				}
			})
			.catch((e) => console.error("[shelf] drag-drop listener failed:", e));

		invoke("setup_shelf_drop").catch((e) => console.error("[shelf] drop target setup failed:", e));

		return () => {
			cancelled = true;
			unlisteners.forEach((fn) => fn());
		};
	}, []);

	// Open the notch on an unseen announcement; stays open until dismissed.
	useEffect(() => {
		if (!announcement || announcementDismissed) return;
		if (announcementShownRef.current === announcement.id) return;
		announcementShownRef.current = announcement.id;
		setBloomMode("announcement");
		if (notchMode === "peek") triggerEventPeek(6000);
	}, [announcement, announcementDismissed, notchMode, triggerEventPeek]);

	// Leave the announcement view once it is dismissed (or gone).
	useEffect(() => {
		if (bloomMode === "announcement" && (!announcement || announcementDismissed)) {
			setBloomMode(mediaInfo.has_media && isPlaying ? "music" : "status");
		}
	}, [bloomMode, announcement, announcementDismissed, mediaInfo.has_media, isPlaying]);

	// Window height is now kept constant to prevent rendering layout lag and sharp corners

	const lastScrollTime = useRef(0);
	const handleWheel = (e: React.WheelEvent) => {
		if (bloomMode === "clipboard" || bloomMode === "shelf" || bloomMode === "notifications") {
			return;
		}
		const target = e.target as HTMLElement;
		if (
			target.closest(".calendar-container") ||
			target.closest(".timer-column") ||
			target.closest(".shelf-content") ||
			target.closest(".clipboard-content") ||
			target.closest(".notif-center-list") ||
			target.closest(".notification-center-content") ||
			target.closest(".qp-list")
		) {
			return;
		}

		const now = Date.now();
		if (now - lastScrollTime.current < 250) return;

		// Use absolute values to detect horizontal swipe gestures on trackpad
		const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
		if (Math.abs(delta) < 5) return; // Ignore tiny movements

		if (cycleBloomMode(delta > 0 ? 1 : -1)) lastScrollTime.current = now;
	};

	function panelEnabled(panel: NotchPanel) {
		if (panel === "calendar") return settingsCalendarEnabled;
		if (panel === "command-center") return settingsControlsPanelEnabled;
		return settingsDevicesPanelEnabled;
	}

	// Settings keeps at least one panel on; if a hand-edited settings file turns
	// them all off, Controls stays so the open notch is never empty.
	function panelAvailable(panel: NotchPanel) {
		if (!NOTCH_PANELS.some(panelEnabled)) return panel === "command-center";
		return panelEnabled(panel);
	}

	// Wheel and swipe navigate panels, even from a collapsed live activity.
	// Music and shelf remain entry points through their activity affordances.
	const cycleBloomMode = (direction: 1 | -1) => {
		if (bloomMode === "announcement") return false;
		const panels = NOTCH_PANELS.filter(panelAvailable);
		const currentIndex = panels.indexOf(bloomMode as NotchPanel);
		const nextMode = currentIndex === -1
			? openingPanel()
			: panels[(currentIndex + direction + panels.length) % panels.length];
		setIsOpen(true);
		setBloomMode(nextMode);
		return true;
	};

	// Arrows and wheel both stay within panels once one is open.
	const cyclePanel = (direction: 1 | -1) => {
		const panels = NOTCH_PANELS.filter(panelAvailable);
		const index = panels.indexOf(bloomMode as NotchPanel);
		if (index === -1 || panels.length < 2) return;
		setBloomMode(panels[(index + direction + panels.length) % panels.length]);
	};

	// Timer state
	const [timerSeconds, setTimerSeconds] = useState(0);
	const [isTimerRunning, setIsTimerRunning] = useState(false);
	const [isTimerFinished, setIsTimerFinished] = useState(false);
	const [isEditingTimer, setIsEditingTimer] = useState(false);
	const [timerEditDigits, setTimerEditDigits] = useState("");
	const [lastDurationSeconds, setLastDurationSeconds] = useState(() => {
		const stored = parseInt(localStorage.getItem("bloom-timer-last-duration") || "", 10);
		return Number.isFinite(stored) && stored > 0 ? stored : 25 * 60;
	});
	const timerInputRef = useRef<HTMLInputElement>(null);
	const timerEditActiveRef = useRef(false);
	const timerIntervalRef = useRef<any>(null);
	const prevTimerFinishedRef = useRef(false);

	const formatTimerTime = (totalSeconds: number) => {
		const mins = Math.floor(Math.abs(totalSeconds) / 60);
		const secs = Math.abs(totalSeconds) % 60;
		return `${mins}:${secs.toString().padStart(2, "0")}`;
	};

	const startTimer = (seconds: number) => {
		// Unlock audio here (user gesture) so the completion chime can play later.
		getTimerChimeCtx();
		timerEditActiveRef.current = false;
		setIsEditingTimer(false);
		setTimerSeconds(seconds);
		setLastDurationSeconds(seconds);
		localStorage.setItem("bloom-timer-last-duration", String(seconds));
		setIsTimerRunning(true);
		setIsTimerFinished(false);
	};

	const resetTimer = () => {
		timerEditActiveRef.current = false;
		setIsEditingTimer(false);
		setIsTimerRunning(false);
		setTimerSeconds(0);
		setIsTimerFinished(false);
	};

	// Idle/finished play restarts the last duration; paused play resumes.
	const handlePrimaryTimerAction = () => {
		if (isEditingTimer) {
			commitTimerEdit(true);
		} else if (isTimerRunning) {
			setIsTimerRunning(false);
		} else if (timerSeconds > 0) {
			getTimerChimeCtx();
			setIsTimerRunning(true);
		} else {
			startTimer(lastDurationSeconds);
		}
	};

	// Keep raw digits in the input; the clock adds the colon without moving the caret.
	const beginTimerEdit = () => {
		if (isTimerRunning || isEditingTimer) return;
		if (isTimerFinished) resetTimer();
		const base = timerSeconds > 0 ? timerSeconds : lastDurationSeconds;
		setTimerEditDigits(timerSecondsToDigits(base));
		timerEditActiveRef.current = true;
		setIsEditingTimer(true);
	};

	const commitTimerEdit = (start: boolean) => {
		if (!timerEditActiveRef.current) return;
		const total = timerDigitsToSeconds(timerEditDigits);
		if (total === null && start) {
			timerInputRef.current?.focus();
			return;
		}
		timerEditActiveRef.current = false;
		setIsEditingTimer(false);
		if (total === null) return;
		const base = timerSeconds > 0 ? timerSeconds : lastDurationSeconds;
		// A tap that changes nothing (e.g. paused timer) must not reset the state.
		if (!start && total === base) return;
		localStorage.setItem("bloom-timer-last-duration", String(total));
		setLastDurationSeconds(total);
		setTimerSeconds(total);
		setIsTimerRunning(start);
		setIsTimerFinished(false);
		if (start) getTimerChimeCtx();
	};

	useEffect(() => {
		if (isEditingTimer) {
			// The notch uses WS_EX_NOACTIVATE: DOM focus alone cannot receive typing.
			let cancelled = false;
			void getCurrentWebviewWindow()
				.setFocus()
				.then(() => {
					if (cancelled) return;
					timerInputRef.current?.focus();
					timerInputRef.current?.select();
				})
				.catch(console.error);
			return () => {
				cancelled = true;
			};
		}
	}, [isEditingTimer]);

	const timerEditValid = timerDigitsToSeconds(timerEditDigits) !== null;

	const timerState: "idle" | "running" | "paused" | "finished" = isEditingTimer
		? "idle"
		: isTimerFinished
			? "finished"
			: isTimerRunning
				? "running"
				: timerSeconds > 0
					? "paused"
					: "idle";
	const timerDisplaySeconds =
		timerSeconds > 0 || isTimerFinished ? timerSeconds : lastDurationSeconds;
	const primaryTimerLabel = isTimerRunning
		? "Pause"
		: timerSeconds > 0
			? "Resume"
			: isTimerFinished
				? "Restart"
				: "Start";
	const timerEndTime =
		timerSeconds > 0 && !isTimerFinished
			? new Date(Date.now() + timerSeconds * 1000).toLocaleTimeString([], {
					hour: "2-digit",
					minute: "2-digit",
					hour12: !timeFormat24h
				})
			: null;

	// Split the display time into individual flip-clock digits. Keys are counted
	// from the right so existing digits keep their identity when minutes grow
	// from two digits to three. The editor occupies the same clock row.
	const clockText = isEditingTimer
		? formatTimerDigits(timerEditDigits)
		: formatTimerTime(timerDisplaySeconds);
	const [clockMinutesText, clockSecondsText] = clockText.split(":");
	const clockMinutesPadded = clockMinutesText.padStart(2, "0");
	const clockCompact = clockMinutesPadded.length > 2;
	const minuteDigitItems = clockMinutesPadded
		.split("")
		.map((digit, i, arr) => ({ digit, key: `m${arr.length - i}` }));
	const secondDigitItems = clockSecondsText
		.split("")
		.map((digit, i, arr) => ({ digit, key: `s${arr.length - i}` }));

	useEffect(() => {
		if (isTimerRunning && timerSeconds > 0) {
			timerIntervalRef.current = setInterval(() => {
				setTimerSeconds((s) => s - 1);
			}, 1000);
		} else if (isTimerRunning && timerSeconds === 0) {
			setIsTimerRunning(false);
			setIsTimerFinished(true);
		}
		return () => {
			if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
		};
	}, [isTimerRunning, timerSeconds === 0]);

	// Completion moment: chime once and reveal the notch in peek mode.
	useEffect(() => {
		if (isTimerFinished && !prevTimerFinishedRef.current) {
			if (settingsTimerSoundEnabled) playTimerChime();
			if (notchMode === "peek") triggerEventPeek(6000);
		}
		prevTimerFinishedRef.current = isTimerFinished;
	}, [isTimerFinished, settingsTimerSoundEnabled, notchMode, triggerEventPeek]);

	const lastTrackRef = useRef<string | null>(null);
	const lastPlayingRef = useRef<boolean>(false);
	const [musicActivityVisible, setMusicActivityVisible] = useState(false);

	// Keep a paused media session visible briefly so it can be resumed, then
	// clear its compact activity even if Windows retains the media session.
	useEffect(() => {
		if (!settingsMusicModeEnabled || !mediaInfo.has_media) {
			setMusicActivityVisible(false);
			return;
		}
		setMusicActivityVisible(true);
		if (isPlaying) return;
		const timeout = window.setTimeout(() => setMusicActivityVisible(false), 5000);
		return () => window.clearTimeout(timeout);
	}, [settingsMusicModeEnabled, mediaInfo.has_media, isPlaying]);

	// Like the Dynamic Island, the collapsed notch shows one live activity at a
	// time. Music fades a few seconds after playback stops. A set timer
	// (running, paused or just finished) takes the pill, and music then moves to
	// its own bubble beside it.
	const timerActive = timerSeconds > 0 || isTimerFinished;
	const musicActivity =
		settingsMusicModeEnabled && settingsMusicCompactNotch && mediaInfo.has_media && musicActivityVisible;
	const collapsedMode = musicActivity && !timerActive ? "music" : "status";
	const showMusicBubble = musicActivity && timerActive && !isOpen && isVisible && !isHidden;
	const showShelfBubble =
		shelfItems.length > 0 && !isOpen && isVisible && !isHidden && bloomMode !== "announcement" && bloomMode !== "shelf";
	const showClipboardBubble =
		clipboardItems.length > 0 && !isOpen && isVisible && !isHidden && bloomMode !== "announcement" && bloomMode !== "clipboard";
	const showNotificationBubble =
		notificationHistory.length > 0 && !isOpen && isVisible && !isHidden && bloomMode !== "announcement" && bloomMode !== "notifications";
	restingModeRef.current = collapsedMode;
	bloomModeRef.current = bloomMode;

	// A click opens the last-used panel when memory is enabled, otherwise the
	// selected default. If that panel is turned off, the first one that's on.
	const openingPanel = (): NotchPanel => {
		const preferred = rememberPanelEnabled ? lastPanel ?? defaultPanel : defaultPanel;
		if (panelAvailable(preferred)) return preferred;
		return NOTCH_PANELS.find(panelAvailable) ?? "command-center";
	};

	// Expands the notch into a panel, or into an activity's own view.
	const openNotch = (view: NotchPanel | "music" | "shelf" | "clipboard" | "notifications") => {
		if (bloomMode === "announcement") return;
		setIsOpen(true);
		setBloomMode(view);
	};

	const rememberPanel = (panel: NotchPanel) => {
		if (panel === lastPanel) return;
		setLastPanel(panel);
		localStorage.setItem("bloom-notch-last-panel", panel);
		invoke("save_setting", { key: "bloom-notch-last-panel", value: panel }).catch(console.error);
	};
	rememberPanelRef.current = rememberPanel;

	// Called by views that take typed input; see releaseNotchHover.
	const setNotchPinned = useCallback((pinned: boolean) => {
		notchPinnedRef.current = pinned;
		if (!pinned && releaseDeferredRef.current) {
			releaseDeferredRef.current = false;
			releaseNotchHover();
		}
		// releaseNotchHover only touches refs and state setters.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// In peek mode, briefly show the notch when a new track starts or playback
	// resumes. The notch itself never switches views for media; the collapsed
	// pill follows the live-activity rule below.
	useEffect(() => {
		const isNewTrackWhilePlaying = mediaInfo.title !== lastTrackRef.current && isPlaying;
		const justStartedPlaying = isPlaying && !lastPlayingRef.current;

		// Peek notch on media events (play start or track change)
		if (notchMode === "peek" && (isNewTrackWhilePlaying || justStartedPlaying)) {
			triggerEventPeek(3000);
		}

		lastTrackRef.current = mediaInfo.title;
		lastPlayingRef.current = isPlaying;
	}, [isPlaying, mediaInfo.title, notchMode, triggerEventPeek]);

	// Leave a panel that has just been turned off in Settings.
	useEffect(() => {
		const panel = asNotchPanel(bloomMode);
		if (panel && !panelAvailable(panel)) {
			setBloomMode(isOpen ? openingPanel() : collapsedMode);
		}
	}, [
		settingsCalendarEnabled,
		settingsControlsPanelEnabled,
		settingsDevicesPanelEnabled,
		bloomMode,
		isOpen
	]);

	// Leave the music view when music is turned off or the player ends its media
	// session: an open notch falls back to the remembered panel.
	useEffect(() => {
		if (bloomMode === "music" && !(settingsMusicModeEnabled && mediaInfo.has_media)) {
			setBloomMode(isOpen ? openingPanel() : collapsedMode);
		}
	}, [settingsMusicModeEnabled, mediaInfo.has_media, bloomMode, isOpen]);

	// A device connecting or disconnecting takes the pill for a few seconds,
	// like the Dynamic Island: its drawing, name and battery. It never takes
	// over a notch the user has open, an announcement or the shelf. In peek
	// and smart modes it shows the notch for as long as it lasts.
	//
	// Alerts for other devices wait their turn (two drives plugged in
	// together show one after the other); a newer alert for the device on
	// screen replaces it. The queue is short: a burst of devices shouldn't
	// hold the notch for long.
	const deviceAlertQueueRef = useRef<Omit<DeviceAlert, "runId">[]>([]);
	const presentDeviceAlertRef = useRef<(alert: Omit<DeviceAlert, "runId">) => void>(() => {});
	presentDeviceAlertRef.current = (alert) => {
		const duration = alert.connected ? DEVICE_ALERT_MS.connected : DEVICE_ALERT_MS.disconnected;
		setDeviceAlert({ ...alert, runId: Date.now() });
		setDeviceAlertOnScreen(true);
		setBloomMode("device");
		if (notchMode === "peek") triggerEventPeek(duration);
		if (deviceAlertTimerRef.current) clearTimeout(deviceAlertTimerRef.current);
		deviceAlertTimerRef.current = setTimeout(() => {
			const next = deviceAlertQueueRef.current.shift();
			if (next && !isOpenRef.current) presentDeviceAlertRef.current(next);
			else {
				deviceAlertQueueRef.current = [];
				setDeviceAlert(null);
			}
		}, duration);
	};
	const showDeviceAlert = useCallback((alert: Omit<DeviceAlert, "runId">) => {
		const mode = bloomModeRef.current;
		if (isOpenRef.current || mode === "announcement" || mode === "shelf" || mode === "clipboard") return;
		const current = deviceAlertRef.current;
		if (current && current.id !== alert.id) {
			const queue = deviceAlertQueueRef.current.filter((queued) => queued.id !== alert.id);
			deviceAlertQueueRef.current = [...queue, alert].slice(-DEVICE_ALERT_QUEUE);
			return;
		}
		presentDeviceAlertRef.current(alert);
	}, []);

	useEffect(() => {
		if (windowLabel !== "main") return;
		const unlistenConnection = listen<BluetoothConnection>("bluetooth-connection", ({ payload }) => {
			showDeviceAlert({
				id: payload.id,
				art: deviceLookFor(payload.name) ?? deviceArtFor(payload),
				name: payload.name,
				connected: payload.connected,
				battery: payload.battery
			});
			// A disconnected device's bud levels are out of date by its next connect.
			if (!payload.connected) {
				setBudsById((all) => {
					if (!(payload.id in all)) return all;
					const { [payload.id]: _gone, ...rest } = all;
					return rest;
				});
			}
		});
		// Windows often reports a battery level a moment after the device
		// connects; fill it into the alert if that device is still showing.
		const unlistenBattery = listen<{ id: string; battery: number }>("bluetooth-battery", ({ payload }) => {
			setDeviceAlert((alert) =>
				alert && alert.id === payload.id && alert.connected ? { ...alert, battery: payload.battery } : alert
			);
		});
		// Earbuds that report each bud's and the case's level send them a
		// moment after connecting.
		const unlistenBuds = listen<BudsBattery & { id: string }>("bluetooth-buds", ({ payload }) => {
			const { id, ...buds } = payload;
			setDeviceAlert((alert) => (alert && alert.id === id && alert.connected ? { ...alert, buds } : alert));
			setBudsById((all) => ({ ...all, [id]: buds }));
		});
		// USB devices, and what's plugged into the 3.5 mm jack. A wired audio
		// device's drawing can be picked in Connected devices.
		const showWired = ({ payload }: { payload: UsbConnection }) => {
			const name = usbDisplayName(payload);
			showDeviceAlert({
				id: payload.id,
				art: (isWiredAudio(payload.class) ? deviceLookFor(name) : null) ?? usbArtFor(payload),
				name,
				connected: payload.connected,
				battery: null,
				usb: true
			});
		};
		const unlistenUsb = listen<UsbConnection>("usb-connection", showWired);
		const unlistenJack = listen<UsbConnection>("wired-audio-connection", showWired);
		return () => {
			unlistenConnection.then((f) => f());
			unlistenBattery.then((f) => f());
			unlistenUsb.then((f) => f());
			unlistenJack.then((f) => f());
			unlistenBuds.then((f) => f());
		};
	}, [windowLabel, showDeviceAlert]);

	// In a dev build, any drawing can be shown from the console, e.g.
	// __bloomDeviceAlert("stem-buds", "AirPods Pro", true, 82), and a late
	// battery report sent with __bloomDeviceBattery("dev", 64).
	useEffect(() => {
		if (!import.meta.env.DEV) return;
		const w = window as unknown as Record<string, unknown>;
		w.__bloomDeviceAlert = (art: DeviceArtKey, name: string, connected = true, battery: number | null = null) =>
			showDeviceAlert({ id: "dev", art, name, connected, battery });
		// __bloomUsb("disk", "SanDisk Cruzer Blade USB Device", true, "a")
		// stands in for the backend's usb-connection event.
		w.__bloomUsb = (kind: string, name: string, connected = true, id = "usb-dev") =>
			showDeviceAlert({
				id,
				art: usbArtFor({ class: kind, name }),
				name: usbDisplayName({ class: kind, name }),
				connected,
				battery: null,
				usb: true
			});
		// __bloomDeviceBuds("dev", [90, false], [80, true], [40, false]) stands
		// in for bluetooth-buds; pass null for a part with no reading.
		const part = (p: [number, boolean] | null) => (p ? { level: p[0], charging: p[1] } : null);
		w.__bloomDeviceBuds = (
			id: string,
			left: [number, boolean] | null,
			right: [number, boolean] | null,
			caseLevel: [number, boolean] | null
		) =>
			setDeviceAlert((alert) =>
				alert && alert.id === id && alert.connected
					? { ...alert, buds: { left: part(left), right: part(right), case: part(caseLevel) } }
					: alert
			);
		w.__bloomDeviceBattery = (id: string, battery: number) =>
			setDeviceAlert((alert) => (alert && alert.id === id && alert.connected ? { ...alert, battery } : alert));
	}, [showDeviceAlert]);

	// The clock row normally returns when the alert's exit animation ends.
	// If the alert never rendered (the notch was still starting up), there's
	// no exit to wait for, so bring it back shortly after the alert ends.
	useEffect(() => {
		if (deviceAlert) return;
		const timer = setTimeout(() => setDeviceAlertOnScreen(false), 400);
		return () => clearTimeout(timer);
	}, [deviceAlert]);

	// Back to the resting view once the alert is over.
	useEffect(() => {
		if (bloomMode === "device" && !deviceAlert) {
			setBloomMode(isOpenRef.current ? openingPanel() : collapsedMode);
		}
		// openingPanel only reads settings state already in this render.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [bloomMode, deviceAlert, collapsedMode]);

	// Notification alert presentation & queue
	const presentNotificationRef = useRef<(notif: AppNotification) => void>(() => {});
	const dismissActiveNotification = useCallback(() => {
		if (notificationAlertTimerRef.current) clearTimeout(notificationAlertTimerRef.current);
		const next = notificationQueueRef.current.shift();
		if (next && !isOpenRef.current) {
			presentNotificationRef.current(next);
		} else {
			setActiveNotification(null);
			setNotificationAlertOnScreen(false);
			setBloomMode(isOpenRef.current ? openingPanel() : collapsedMode);
		}
	}, [collapsedMode, openingPanel]);

	presentNotificationRef.current = (notif: AppNotification) => {
		setActiveNotification(notif);
		setNotificationAlertOnScreen(true);
		setBloomMode("notification");
		if (notchMode === "peek") triggerEventPeek(7000);
		if (notificationAlertTimerRef.current) clearTimeout(notificationAlertTimerRef.current);
		notificationAlertTimerRef.current = setTimeout(() => {
			dismissActiveNotification();
		}, 7000);
	};

	const showNotification = useCallback(
		(notif: AppNotification) => {
			setUnreadNotificationCount((c) => c + 1);
			setNotificationHistory((prev) => {
				const next = [notif, ...prev.filter((n) => n.id !== notif.id)].slice(0, 50);
				try {
					localStorage.setItem("bloom-notification-history", JSON.stringify(next));
				} catch {}
				return next;
			});

			if (
				isOpenRef.current ||
				bloomModeRef.current === "announcement" ||
				bloomModeRef.current === "notifications" ||
				zoomedImageItem
			) {
				notificationQueueRef.current.push(notif);
				return;
			}
			if (activeNotificationRef.current) {
				notificationQueueRef.current.push(notif);
				return;
			}
			presentNotificationRef.current(notif);
		},
		[zoomedImageItem]
	);

	const deleteNotification = (id: number) => {
		setNotificationHistory((prev) => {
			const next = prev.filter((n) => n.id !== id);
			try {
				localStorage.setItem("bloom-notification-history", JSON.stringify(next));
			} catch {}
			return next;
		});
		invoke("dismiss_notification", { id }).catch(() => {});
	};

	const clearAllNotifications = () => {
		setNotificationHistory([]);
		setUnreadNotificationCount(0);
		try {
			localStorage.removeItem("bloom-notification-history");
		} catch {}
	};

	useEffect(() => {
		if (windowLabel !== "main") return;
		const unlisten = listen<AppNotification>("app-notification", ({ payload }) => {
			showNotification(payload);
		});
		return () => {
			unlisten.then((f) => f());
		};
	}, [showNotification, windowLabel]);

	useEffect(() => {
		if (activeNotification) return;
		const timer = setTimeout(() => setNotificationAlertOnScreen(false), 400);
		return () => clearTimeout(timer);
	}, [activeNotification]);

	useEffect(() => {
		if (bloomMode === "notification" && !activeNotification) {
			setBloomMode(isOpenRef.current ? openingPanel() : collapsedMode);
		}
	}, [bloomMode, activeNotification, collapsedMode, openingPanel]);

	// The collapsed notch always shows its current live activity: music while a
	// session exists, the timer (with music in its bubble) once one is set, and
	// the clock otherwise. An open notch is left alone.
	useEffect(() => {
		if (isOpen || announcementOpenRef.current) return;
		if ((bloomMode === "status" || bloomMode === "music") && bloomMode !== collapsedMode) {
			setBloomMode(collapsedMode);
		}
	}, [collapsedMode, bloomMode, isOpen]);

	// Update time
	useEffect(() => {
		const updateTime = () => {
			const now = new Date();
			setTime(
				now.toLocaleTimeString([], {
					hour: "2-digit",
					minute: "2-digit",
					hour12: !timeFormat24h
				})
			);
		};

		updateTime();
		const interval = setInterval(updateTime, 1000);

		return () => {
			clearInterval(interval);
		};
	}, [timeFormat24h]);

	// Battery API
	useEffect(() => {
		let battery: any = null;

		const initBattery = async () => {
			try {
				battery = await (navigator as any).getBattery();

				const updateBattery = () => {
					setBatteryLevel(Math.round(battery.level * 100));
					setIsCharging(battery.charging);
				};

				updateBattery();

				battery.addEventListener("levelchange", updateBattery);
				battery.addEventListener("chargingchange", updateBattery);

				return () => {
					battery.removeEventListener("levelchange", updateBattery);
					battery.removeEventListener("chargingchange", updateBattery);
				};
			} catch (e) {
				// Battery API not supported
			}
		};

		initBattery();
	}, []);

	// Listen for Volume Changes
	useEffect(() => {
		const unlisten = listen<{ volume: number; is_muted: boolean }>("volume-change", (event) => {
			setVolume(event.payload.volume);
			setIsMuted(event.payload.is_muted);
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	// Wi-Fi is a three-state control: Off, on-but-not-connected, Connected.
	// The radio state alone can't tell those apart, so get_wifi_status returns
	// both flags, plus the connected network's name. Returns false so the startup loader knows to retry.
	const refreshWifiStatus = useCallback(async (): Promise<boolean> => {
		try {
			setWifiStatus(await invoke<WifiStatus>("get_wifi_status"));
			return true;
		} catch {
			return false;
		}
	}, []);

	// Seed the Wi-Fi pill at startup. The first call can fail while the WLAN
	// service is still coming up, so retry instead of leaving the pill stuck on
	// its default.
	useEffect(() => {
		let cancelled = false;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		const initializeWifiStatus = async (attempt: number) => {
			const loaded = await refreshWifiStatus();
			if (!loaded && !cancelled && attempt < 3) {
				retryTimer = setTimeout(() => void initializeWifiStatus(attempt + 1), (attempt + 1) * 1000);
			}
		};
		void initializeWifiStatus(0);
		return () => {
			cancelled = true;
			if (retryTimer) clearTimeout(retryTimer);
		};
	}, [refreshWifiStatus]);

	// Connected Bluetooth devices for the tile, refreshed whenever the backend
	// reports a device connecting, disconnecting, pairing or being removed.
	useEffect(() => {
		if (!bluetoothEnabled) {
			setBtConnectedNames([]);
			return;
		}
		const refresh = () =>
			invoke<{ name: string; connected: boolean }[]>("bluetooth_list_devices")
				.then((devices) =>
					setBtConnectedNames(devices.filter((d) => d.connected).map((d) => d.name))
				)
				.catch(() => {});
		let debounce: ReturnType<typeof setTimeout> | undefined;
		void refresh();
		const unlisten = listen("bluetooth-changed", () => {
			clearTimeout(debounce);
			debounce = setTimeout(() => void refresh(), 400);
		});
		return () => {
			clearTimeout(debounce);
			unlisten.then((f) => f());
		};
	}, [bluetoothEnabled]);

	// The backend reports connection changes and finished scans as they
	// happen, so the pill follows without waiting for the next poll.
	useEffect(() => {
		let debounce: ReturnType<typeof setTimeout> | undefined;
		const unlisten = listen("wifi-changed", () => {
			clearTimeout(debounce);
			debounce = setTimeout(() => void refreshWifiStatus(), 300);
		});
		return () => {
			clearTimeout(debounce);
			unlisten.then((f) => f());
		};
	}, [refreshWifiStatus]);

	// Load bluetooth/volume/brightness state on mount
	useEffect(() => {
		invoke<boolean>("get_bluetooth_state")
			.then(setBluetoothEnabled)
			.catch(() => {});
		invoke<boolean>("get_battery_saver_state")
			.then(setBatterySaverEnabled)
			.catch(() => {});
		invoke<{ volume: number; is_muted: boolean }>("get_volume_state")
			.then((state) => {
				setVolume(state.volume);
				setIsMuted(state.is_muted);
			})
			.catch(() => {});
		invoke<number>("get_brightness")
			.then(setCurrentBrightness)
			.catch(() => {});

		// Poll battery saver state every 5s (since we can't listen for changes)
		const interval = setInterval(() => {
			invoke<boolean>("get_battery_saver_state")
				.then(setBatterySaverEnabled)
				.catch(() => {});
		}, 5000);
		return () => clearInterval(interval);
	}, []);

	// Refresh Wi-Fi status while the command center is open so changes made
	// outside Bloom (keyboard toggle, Windows quick settings) show up.
	useEffect(() => {
		if (bloomMode !== "command-center") return;
		void refreshWifiStatus();
		const interval = setInterval(() => void refreshWifiStatus(), 5000);
		return () => clearInterval(interval);
	}, [bloomMode, refreshWifiStatus]);

	// Poll system metrics for status widgets
	useEffect(() => {
		const fetchMetrics = () => {
			invoke<number>("get_cpu_usage")
				.then(setCpuUsage)
				.catch((e) => console.warn("CPU:", e));
			invoke<number>("get_ram_usage")
				.then(setRamUsage)
				.catch((e) => console.warn("RAM:", e));
			invoke<number>("get_disk_space")
				.then(setDiskSpace)
				.catch((e) => console.warn("Disk:", e));
			invoke<[number, number]>("get_network_speed")
				.then(([up, down]) => {
					setNetUpSpeed(up);
					setNetDownSpeed(down);
				})
				.catch(() => {});
		};
		fetchMetrics();
		const interval = setInterval(fetchMetrics, 3000);
		return () => clearInterval(interval);
	}, []);

	// Listen for brightness changes
	useEffect(() => {
		const unlisten = listen<{ brightness: number }>("brightness-change", (event) => {
			setCurrentBrightness(event.payload.brightness);
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	// Native Windows Media Controls - Listen for updates from background worker
	useEffect(() => {
		const unlisten = listen<MediaInfo>("media-update", (event) => {
			const info = event.payload;
			if (!info) return;

			setMediaInfo((prev) => {
				// Find if artwork changed by checking the first element
				const prevArt = prev.artwork?.[0];
				const nextArt = info.artwork?.[0];
				const artChanged = prevArt !== nextArt;

				if (
					prev.title === info.title &&
					prev.artist === info.artist &&
					prev.is_playing === info.is_playing &&
					prev.has_media === info.has_media &&
					!artChanged &&
					prev.position_ms === info.position_ms &&
					prev.duration_ms === info.duration_ms
				) {
					return prev;
				}

				// Update playing state separately for the hook triggers
				setIsPlaying(info.is_playing);

				if (info.artwork && info.artwork.length > 0) {
					const newArt = info.artwork[0];
					setAlbumArtUrl((prev) => {
						if (prev !== newArt) {
							setAlbumArtKey((k) => k + 1);
							return newArt;
						}
						return prev;
					});
				} else {
					setAlbumArtUrl(null);
				}

				return info;
			});
		});

		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	// Media controls via Tauri commands
	/* Unused saveAndBroadcast removed to fix TS build error */
	const togglePlayPause = useCallback(async () => {
		try {
			await invoke("media_play_pause");
			setIsPlaying(!isPlaying);
		} catch (e) {
			console.error("Failed to toggle play/pause:", e);
		}
	}, [isPlaying]);

	const skipNext = useCallback(async () => {
		try {
			await invoke("media_next");
		} catch (e) {
			console.error("Failed to skip next:", e);
		}
	}, []);

	const skipPrevious = useCallback(async () => {
		try {
			await invoke("media_previous");
		} catch (e) {
			console.error("Failed to skip previous:", e);
		}
	}, []);

	// Slide-push animation for prev/next buttons
	const prevFront = useAnimation();
	const prevBack = useAnimation();
	const nextFront = useAnimation();
	const nextBack = useAnimation();

	const animatePrev = useCallback(async () => {
		prevFront.set({ x: 0 });
		prevBack.set({ x: 30 });
		prevFront.start({ x: -30, transition: { duration: 0.18, ease: [0.4, 0, 0.2, 1] } });
		await prevBack.start({ x: 0, transition: { duration: 0.18, ease: [0.4, 0, 0.2, 1] } });
		skipPrevious();
	}, [skipPrevious, prevFront, prevBack]);

	const animateNext = useCallback(async () => {
		nextFront.set({ x: 0 });
		nextBack.set({ x: -30 });
		nextFront.start({ x: 30, transition: { duration: 0.18, ease: [0.4, 0, 0.2, 1] } });
		await nextBack.start({ x: 0, transition: { duration: 0.18, ease: [0.4, 0, 0.2, 1] } });
		skipNext();
	}, [skipNext, nextFront, nextBack]);

	const sendVolume = useTrailingThrottle((newVol: number) => {
		invoke("set_volume", { volume: newVol }).catch(() => {});
	}, 50);

	const handleVolumeChange = useCallback(
		(newVol: number) => {
			if (volume > 0 && !isMuted) previousVolume.current = volume;
			setVolume(newVol);
			// set_volume unmutes for any non-zero level.
			setIsMuted(newVol === 0);
			sendVolume(newVol);
		},
		[sendVolume, volume, isMuted]
	);
	const CommandVolumeIcon =
		displayVolume === 0
			? VolumeX
			: displayVolume < 0.33
				? Volume
				: displayVolume < 0.67
					? Volume1
					: Volume2;
	const CommandBrightnessIcon =
		currentBrightness < 34 ? SunDim : currentBrightness < 67 ? SunMedium : Sun;
	const toggleVolumeLevel = () => {
		handleVolumeChange(
			displayVolume > 0 ? 0 : isMuted && volume > 0 ? volume : previousVolume.current
		);
	};

	// WiFi toggle
	const toggleWifi = useCallback(async () => {
		const previous = wifiStatus;
		const newState = !(previous?.enabled ?? false);
		setWifiStatus({
			enabled: newState,
			connected: newState ? (previous?.connected ?? false) : false,
			ssid: newState ? (previous?.ssid ?? null) : null
		});
		try {
			await invoke("set_wifi_state", { enabled: newState });
			// The radio and association take a moment to settle.
			setTimeout(() => void refreshWifiStatus(), 800);
		} catch (e) {
			setWifiStatus(previous);
			console.error("Failed to toggle WiFi:", e);
		}
	}, [wifiStatus, refreshWifiStatus]);

	// Bluetooth toggle
	const toggleBluetooth = useCallback(async () => {
		const newState = !bluetoothEnabled;
		setBluetoothEnabled(newState);
		try {
			await invoke("set_bluetooth_state", { enabled: newState });
		} catch (e) {
			setBluetoothEnabled(!newState);
			console.error("Failed to toggle Bluetooth:", e);
		}
	}, [bluetoothEnabled]);

	// The notch never takes focus, and native `title` tooltips only show for an
	// active window, so the status widgets draw their own. A tooltip opens
	// after a tooltip-like delay, by which time the battery details fetched on
	// enter are in. Under the status strip it hangs below the pill; once the
	// notch is open the pill is the tall panel, so it sits beside the pill on
	// the widget's side instead, level with the widget.
	const showStatusTooltip = useCallback(
		(id: string, widget: HTMLElement) => {
			if (statusTooltipTimerRef.current) clearTimeout(statusTooltipTimerRef.current);
			statusTooltipTimerRef.current = setTimeout(() => {
				const pill = bloomRef.current?.getBoundingClientRect();
				const own = widget.getBoundingClientRect();
				// Client rects are zoomed by the notch scale; offsets are not.
				if (!pill) {
					setStatusTooltip({ id, side: "below", offset: 8 });
				} else if (!isOpen) {
					const gap = (pill.bottom - own.bottom) / scale;
					setStatusTooltip({ id, side: "below", offset: Math.max(0, gap) + 8 });
				} else if (own.left + own.width / 2 >= pill.left + pill.width / 2) {
					const gap = (pill.right - own.right) / scale;
					setStatusTooltip({ id, side: "right", offset: Math.max(0, gap) + 10 });
				} else {
					const gap = (own.left - pill.left) / scale;
					setStatusTooltip({ id, side: "left", offset: Math.max(0, gap) + 10 });
				}
			}, 400);
		},
		[scale, isOpen]
	);

	const hideStatusTooltip = useCallback(() => {
		if (statusTooltipTimerRef.current) clearTimeout(statusTooltipTimerRef.current);
		statusTooltipTimerRef.current = null;
		setStatusTooltip(null);
	}, []);

	// Widgets unmount when the notch collapses, without a mouse leave, and an
	// open card is placed for the notch's shape when it opened.
	useEffect(() => {
		hideStatusTooltip();
	}, [isHovered, isOpen, hideStatusTooltip]);

	// Both sides of the status strip get equal width around the centered
	// clock, so the notch must fit the clock plus twice the wider side. Widget
	// widths vary (network speed especially), so they are measured rather than
	// counted. The width only grows during a hover, so a live label getting
	// shorter doesn't make the notch jitter. Layout widths are unaffected by
	// the notch scale.
	useLayoutEffect(() => {
		if (!isHovered || bloomMode !== "status") {
			if (statusFitWidth !== 0) setStatusFitWidth(0);
			return;
		}
		// offsetWidth, not scrollWidth: an open tooltip card overflows its
		// widget and must not widen the notch.
		const side = Math.max(
			leftWidgetsRef.current?.offsetWidth ?? 0,
			rightWidgetsRef.current?.offsetWidth ?? 0
		);
		const clock = timeCenterRef.current?.offsetWidth ?? 0;
		// The pill's 12px padding on each side, and a 10px gap to the clock.
		const needed = Math.ceil(clock + 2 * (side + 10) + 24);
		if (side > 0 && needed > statusFitWidth) setStatusFitWidth(needed);
	});

	const refreshBatteryDetails = useCallback(() => {
		invoke<BatteryDetails>("get_battery_details")
			.then(setBatteryDetails)
			.catch((err) => console.error("Failed to read battery details:", err));
	}, []);

	// Battery Saver - opens settings (no public API to toggle without admin)
	const openBatterySaverSettings = useCallback(async () => {
		try {
			await invoke("open_battery_saver_settings");
		} catch (e) {
			console.error("Failed to open Battery Saver settings:", e);
		}
	}, []);

	// Brightness change with throttling
	const sendBrightness = useTrailingThrottle((newVal: number) => {
		invoke("set_brightness", { brightness: newVal }).catch(() => {});
	}, 50);

	const handleBrightnessChange = useCallback(
		(newVal: number) => {
			if (currentBrightness > 0) previousBrightness.current = currentBrightness;
			setCurrentBrightness(newVal);
			sendBrightness(newVal);
		},
		[sendBrightness, currentBrightness]
	);
	const toggleBrightnessLevel = () => {
		handleBrightnessChange(currentBrightness > 0 ? 0 : previousBrightness.current);
	};

	// Open system tray (unhide taskbar and invoke Win+B)
	const openSystemTray = useCallback(async (e: React.MouseEvent) => {
		e.stopPropagation();
		try {
			await invoke("open_system_tray");
		} catch (e) {
			console.error("Failed to open system tray:", e);
		}
	}, []);

	const openSettingsWindow = useCallback(async () => {
		try {
			await invoke("open_settings_window");
		} catch (e) {
			console.error("Failed to open settings window:", e);
		}
	}, []);

	// Right-click opens the tile's own view, the same as its › button.
	const handleWifiRightClick = useCallback((e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setBloomMode("wifi");
	}, []);

	const toggleDockModeSetting = useCallback(
		async (e: React.MouseEvent) => {
			e.stopPropagation();
			const nextMode = dockMode === "fixed" ? "smart" : dockMode === "smart" ? "peek" : "fixed";
			setDockMode(nextMode);
			localStorage.setItem("bloom-dock-mode", nextMode);
			invoke("save_setting", { key: "bloom-dock-mode", value: nextMode }).catch(console.error);
			try {
				await invoke("change_dock_mode", { mode: nextMode });
			} catch (err) {
				console.error("Failed to change dock mode:", err);
			}
		},
		[dockMode]
	);

	const toggleNotchModeSetting = useCallback(
		async (e: React.MouseEvent) => {
			e.stopPropagation();
			const nextMode = notchMode === "fixed" ? "smart" : notchMode === "smart" ? "peek" : "fixed";
			setNotchMode(nextMode);
			localStorage.setItem("bloom-notch-mode", nextMode);
			invoke("save_setting", { key: "bloom-notch-mode", value: nextMode }).catch(console.error);
			try {
				await invoke("change_notch_mode", { mode: nextMode });
			} catch (err) {
				console.error("Failed to change notch mode:", err);
			}
		},
		[notchMode]
	);

	const handleBluetoothRightClick = useCallback((e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setBloomMode("bluetooth");
	}, []);

	const toggleCalendarMode = (e: React.MouseEvent) => {
		e.stopPropagation();
		if (isTimerFinished) {
			resetTimer();
			return;
		}
		// The time is part of the notch: a click opens it like anywhere else.
		// Once open, it is a shortcut to the calendar.
		if (!isOpen) {
			openNotch(openingPanel());
		} else if (settingsCalendarEnabled) {
			setBloomMode("calendar");
		}
	};

	// Where a status tooltip card sits and how it slides in, by placement.
	const statusTooltipMotion = (side: "below" | "left" | "right", offset: number) => {
		if (side === "below") {
			return {
				style: { top: `calc(100% + ${offset}px)`, left: "50%" },
				hidden: { opacity: 0, x: "-50%", y: -4 },
				shown: { opacity: 1, x: "-50%", y: 0 }
			};
		}
		// Top-aligned with the widget rather than centered on it: the widgets
		// sit near the top of the screen, which would cut a centered card off.
		const nudge = side === "right" ? -4 : 4;
		return {
			style: { top: -8, [side === "right" ? "left" : "right"]: `calc(100% + ${offset}px)` },
			hidden: { opacity: 0, x: nudge, y: 0 },
			shown: { opacity: 1, x: 0, y: 0 }
		};
	};

	// A status widget with its tooltip card, which hangs outside the pill.
	const statusWidget = (
		id: string,
		tooltip: string,
		content: React.ReactNode,
		onEnter?: () => void
	) => (
		<div
			className="passive-feature"
			key={id}
			onMouseEnter={(e) => {
				onEnter?.();
				showStatusTooltip(id, e.currentTarget);
			}}
			onMouseLeave={hideStatusTooltip}
		>
			{content}
			<AnimatePresence>
				{statusTooltip?.id === id &&
					(() => {
						const placed = statusTooltipMotion(statusTooltip.side, statusTooltip.offset);
						return (
							<motion.div
								className="status-tooltip"
								style={placed.style}
								initial={placed.hidden}
								animate={placed.shown}
								exit={placed.hidden}
								transition={{ duration: 0.15 }}
							>
								{tooltip}
							</motion.div>
						);
					})()}
			</AnimatePresence>
		</div>
	);

	// Render a status widget by ID
	const renderStatusWidget = (id: string) => {
		switch (id) {
			case "weather":
				if (!settingsWeatherEnabled || temperature === null) return null;
				return statusWidget(
					"weather",
					cityName ? `${weatherCondition} — ${cityName}` : weatherCondition,
					<>
						<WeatherIcon size={12} strokeWidth={2.2} />
						<span className="label">
							{temperature}°{tempUnit === "fahrenheit" ? "F" : "C"}
						</span>
					</>
				);
			case "battery":
				return statusWidget(
					"battery",
					batteryTooltip(
						batteryDetails,
						{ level: batteryLevel, charging: isCharging },
						batterySaverEnabled
					),
					<>
						<BatteryIcon
							charging={isCharging}
							level={batteryLevel}
							threshold={lowBatteryThreshold}
						/>
						<span className="label">{batteryLevel}%</span>
					</>,
					refreshBatteryDetails
				);
			case "cpu":
				return statusWidget(
					"cpu",
					"CPU Usage",
					<>
						<Cpu size={12} strokeWidth={2} />
						<span className="label">{cpuUsage}%</span>
					</>
				);
			case "ram":
				return statusWidget(
					"ram",
					"RAM Usage",
					<>
						<MemoryStick size={12} strokeWidth={2} />
						<span className="label">{Math.round(ramUsage)}%</span>
					</>
				);
			case "disk":
				return statusWidget(
					"disk",
					"Free Disk Space",
					<>
						<HardDrive size={12} strokeWidth={2} />
						<span className="label">{diskSpace}GB</span>
					</>
				);
			case "net":
				return statusWidget(
					"net",
					"Network Speed",
					<>
						<ArrowUpDown size={12} strokeWidth={2} />
						<span className="label">
							↑{formatBytes(netUpSpeed)} ↓{formatBytes(netDownSpeed)}
						</span>
					</>
				);
			default:
				return null;
		}
	};

	const formatBytes = (bytes: number) => {
		if (bytes < 1024) return `${bytes}B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
		return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
	};

	// Music mode shows any time we have media info (playing or paused) and music mode setting is enabled
	const isMusicMode = mediaInfo.has_media && bloomMode === "music" && settingsMusicModeEnabled;
	// A media session remains reachable on hover after its activity fades, or
	// whenever the compact music display is disabled.
	const showMusicOnStatusHover =
		!isOpen && isHovered && bloomMode === "status" && settingsMusicModeEnabled &&
		mediaInfo.has_media && (!musicActivityVisible || !settingsMusicCompactNotch);
	const showCompactMusicIcons = isMusicMode || showMusicOnStatusHover;

	// The 24-hour clock is ~16px narrower than the 12-hour one.
	const clock24hTrim = timeFormat24h ? 16 : 0;

	// Calculate width dynamically based on enabled features
	const getDynamicWidth = () => {
		if (bloomMode === "announcement" && announcement && !announcementDismissed) return 380;
		if (bloomMode === "device" && deviceAlert) return 330;
		if (bloomMode === "notification" && activeNotification) return 390;
		if (bloomMode === "notifications") return 400;
		if (isCalendarMode) return 480;
		if (bloomMode === "shelf") return 380;
		if (bloomMode === "clipboard") {
			if (zoomedImageItem) return 520;
			return clipboardItems.length <= 1 ? 320 : 490;
		}
		if (bloomMode === "command-center" && isOpen) return COMMAND_CENTER_WIDTH;
		if (bloomMode === "wifi" || bloomMode === "bluetooth") return COMMAND_CENTER_WIDTH;
		if (bloomMode === "devices") return 350;
		if (showMusicOnStatusHover) {
			return 170 + (settingsVisualizerEnabled ? 30 : 0);
		}
		if (bloomMode === "status" && isHovered) {
			const totalWidgets = statusWidgets.left.length + statusWidgets.right.length;
			return Math.max(Math.min(200 + totalWidgets * 50, 380) - clock24hTrim, statusFitWidth);
		}
		if (isMusicMode && isOpen) return mediaLayout === "compact" ? 300 : 340;
		if ((showPowerPulse || showLowBatteryPulse || showUpdatePulse) && !isHovered) return 200;

		let w = 140 - clock24hTrim;
		if (isMusicMode) {
			if (settingsVisualizerEnabled && isPlaying) w += 30;
			if (settingsAlbumArtEnabled) w += 30;
		}

		return w;
	};

	const getDynamicHeight = () => {
		if (!isExpanded || !isVisible || isHidden) {
			return isImpacted ? 28.9 : 44.2;
		}
		// Announcement card: body is line-clamped, so a fixed size fits both cases.
		if (bloomMode === "announcement" && announcement && !announcementDismissed) {
			return announcement.url ? 168 : 148;
		}
		// Device alert: the drawing, with room for its motion.
		if (bloomMode === "device" && deviceAlert) return 76;
		if (bloomMode === "notification" && activeNotification) {
			return activeNotification.body ? 64 : 50;
		}
		if (bloomMode === "notifications") {
			if (notificationHistory.length === 0) return 170;
			if (notificationHistory.length === 1) return 165;
			if (notificationHistory.length === 2) return 255;
			if (notificationHistory.length === 3) return 345;
			return 420;
		}
		// Sized to the calendar's week-row count plus the timer's fixed content.
		if (bloomMode === "calendar") return 112 + calendarRows(calendarMonth, calendarMondayFirst) * 30;
		// Shelf expands on mode alone (no hover needed: there is no cursor
		// hover during an OS drag) and is sized to exactly one row of tiles,
		// plus room for the scrollbar once the tiles overflow it.
		if (bloomMode === "shelf") {
			return shelfItems.length === 0 ? 140 : 196;
		}
		if (bloomMode === "clipboard") {
			if (zoomedImageItem) return 340;
			if (clipboardItems.length === 0) return 130;
			const rows = Math.min(Math.max(1, Math.ceil(clipboardItems.length / 2)), 5);
			return Math.round(82 + rows * 41);
		}
		if (bloomMode === "command-center") return isOpen ? 230 : 36;
		if (bloomMode === "devices") {
			return devicesPanelHeight;
		}
		if (bloomMode === "wifi" || bloomMode === "bluetooth") return 300;
		if (bloomMode === "status") return 36;
		if (isMusicMode && isOpen) {
			const hasProgressBar = (mediaInfo.duration_ms ?? 0) > 0;
			let h = mediaLayout === "compact" ? (hasProgressBar ? 132 : 116) : 120;
			if (mediaLayout === "compact") {
				if (compactVolumeExpanded) h += 36;
			}
			return h;
		}
		return 36;
	};

	const isCalendarMode = bloomMode === "calendar";
	// Arrows switch between the two tool panels; wheel/swipe can also open one
	// directly from the collapsed pill or a live activity.
	const showPanelArrows =
		isOpen && asNotchPanel(bloomMode) !== null && NOTCH_PANELS.filter(panelAvailable).length > 1;

	// Close compact media player expansions when notch is unhovered or mode changes
	useEffect(() => {
		if (mediaLayout === "compact") {
			setCompactVolumeExpanded(false);
		}
	}, [isHovered, mediaLayout, bloomMode]);

	// The pill's target geometry: the animation springs toward it, and the
	// window region below is cut from it, so the region is already at the
	// final size while the pill animates.
	const pillTargetY = !isReady ? 250 : isVisible ? (isHidden ? -100 : 0) : -150;
	const pillTargetWidth = !isReady
		? 34
		: isExpanded && isVisible && !isHidden
			? getDynamicWidth()
			: isImpacted
				? 39.1
				: 30.6;
	const pillTargetHeight = !isReady ? 34 : getDynamicHeight();
	// Shadow and the edge flares beside the pill.
	pillTargetRef.current = notchPillBox(
		window.innerWidth,
		scale,
		pillTargetY,
		pillTargetWidth,
		pillTargetHeight,
		24
	);

	// Clip the notch window to what it draws (see window_region.rs): outside
	// these rectangles the window takes no clicks, whatever its click-through
	// state. Sent after every render, but only when the region changes.
	useEffect(() => {
		if (windowLabel === "main") updateNotchRegion();
	});

	// Side-by-side positioning for activity bubbles on the right of the collapsed notch
	const notifBubbleCount = unreadNotificationCount > 0 ? unreadNotificationCount : notificationHistory.length;
	const notifBubbleWidth = notifBubbleCount >= 100 ? 56 : notifBubbleCount >= 10 ? 49 : 42;
	const clipBubbleWidth = clipboardItems.length >= 100 ? 56 : clipboardItems.length >= 10 ? 49 : 42;

	const notificationBubbleMarginLeft = getDynamicWidth() / 2 + 8;
	const clipboardBubbleMarginLeft =
		getDynamicWidth() / 2 + 8 + (showNotificationBubble ? notifBubbleWidth + 6 : 0);
	const musicBubbleMarginLeft =
		getDynamicWidth() / 2 +
		8 +
		(showNotificationBubble ? notifBubbleWidth + 6 : 0) +
		(showClipboardBubble ? clipBubbleWidth + 6 : 0);

	return (
		<div className="screen" style={{ overflow: "hidden" }}>
			{/* Screen Corners (Top) */}
			<AnimatePresence>
				{isVisible && settingsCornersEnabled && (
					<>
						<motion.div
							className="screen-corner top-left"
							initial={{ opacity: 0 }}
							animate={{ opacity: 1, filter: "blur(0px)" }}
							exit={{ opacity: 0, filter: "blur(10px)" }}
						/>
						<motion.div
							className="screen-corner top-right"
							initial={{ opacity: 0 }}
							animate={{ opacity: 1, filter: "blur(0px)" }}
							exit={{ opacity: 0, filter: "blur(10px)" }}
						/>
					</>
				)}
			</AnimatePresence>

			<div
				style={{
					zoom: scale,
					width: "100%",
					display: "flex",
					justifyContent: "center",
					position: "relative"
				}}
			>
				<DeviceArtDefs />
				<motion.div
					ref={bloomRef}
					className={`bloom ${isHovered ? "expanded" : ""} ${isImpacted ? "is-impacted" : ""} ${isDragHovering ? "drag-hover" : ""}`}
					onMouseEnter={() => setIsNotchHovered(true)}
					onMouseLeave={() => {
						setIsNotchHovered(false);
						releaseNotchHover();
					}}
					onWheel={handleWheel}
					initial={{
						y: 250,
						width: 30.6,
						height: 44.2,
						borderTopLeftRadius: 18,
						borderTopRightRadius: 18,
						borderBottomLeftRadius: 18,
						borderBottomRightRadius: 18,
						scaleX: 1,
						scaleY: 1,
						opacity: 0
					}}
					animate={{
						y: pillTargetY,
						width: pillTargetWidth,
						height: pillTargetHeight,
						opacity: isVisible ? 1 : 0,
						scaleX: 1,
						scaleY: 1,
						borderTopLeftRadius: isImpacted ? 0 : 18,
						borderTopRightRadius: isImpacted ? 0 : 18,
						borderBottomLeftRadius: isCalendarMode ? 28 : 18,
						borderBottomRightRadius: isCalendarMode ? 28 : 18,
						filter: isVisible ? "blur(0px)" : "blur(8px)",
						pointerEvents: isVisible ? "auto" : "none"
					}}
					onClick={(e) => {
						e.stopPropagation();
						if (!isOpen) openNotch(openingPanel());
					}}
					onHoverStart={() => {
						releaseDeferredRef.current = false;
						setIsHovered(true);
						// Hovering the shelf cancels its post-drop auto-close.
						if (bloomMode === "shelf") clearShelfCollapse();
					}}
					onHoverEnd={releaseNotchHover}
					style={{ originY: 0 }}
					transition={{
						width: { type: "spring", stiffness: 400, damping: 31 },
						height: { type: "spring", stiffness: 450, damping: 29 },
						y: { type: "spring", stiffness: 550, damping: 45, mass: 0.8, restDelta: 0.001 },
						opacity: { duration: 0.2 },
						borderTopLeftRadius: { type: "spring", stiffness: 1000, damping: 40 },
						borderTopRightRadius: { type: "spring", stiffness: 1000, damping: 40 },
						borderBottomLeftRadius: { type: "spring", stiffness: 1000, damping: 40 },
						borderBottomRightRadius: { type: "spring", stiffness: 1000, damping: 40 },
						default: { type: "spring", stiffness: 500, damping: 30, mass: 1 }
					}}
				>
					<EdgeSurface edge="top" flares={isImpacted} reflective={edgeShineEnabled} />
					<AnimatePresence>
						{isMusicMode && settingsAmbienceEnabled && albumArtUrl && isOpen && !isCalendarMode && (
							<motion.div
								className="notch-ambient-glow"
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								transition={{ duration: 0.15 }}
							>
								<AnimatePresence mode="wait">
									<motion.img
										key={albumArtUrl}
										src={albumArtUrl}
										alt=""
										draggable={false}
										initial={{ opacity: 0, scale: 1.1 }}
										animate={{ opacity: 1, scale: 1.8 }}
										exit={{ opacity: 0 }}
										transition={{ duration: 0.3 }}
									/>
								</AnimatePresence>
							</motion.div>
						)}
					</AnimatePresence>
					<AnimatePresence mode="wait">
						{isExpanded && (
							<motion.div
								key="bloom-content"
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								transition={{ duration: 0.1 }}
								style={{
									width: "100%",
									height: "100%",
									display: "flex",
									flexDirection: "column",
									alignItems: "center",
									position: "relative",
									borderRadius: "inherit"
								}}
							>
								{/* Faster Waiting Transition Area */}
								<AnimatePresence mode="wait">
									{isOpen && isMusicMode && !isCalendarMode ? (
										<motion.div
											key="expanded-music"
											className="expanded-music-container"
											initial={{ opacity: 0, scale: 0.98 }}
											animate={{ opacity: 1, scale: 1 }}
											exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
											transition={{ type: "spring", stiffness: 500, damping: 30 }}
										>
											{mediaLayout === "compact" ? (
												<CompactMediaPlayer
													mediaInfo={mediaInfo}
													albumArtUrl={albumArtUrl}
													albumArtKey={albumArtKey}
													isPlaying={isPlaying}
													volume={displayVolume}
													volumeExpanded={compactVolumeExpanded}
													onVolumeExpandedChange={setCompactVolumeExpanded}
													onTogglePlayPause={togglePlayPause}
													onVolumeChange={handleVolumeChange}
													prevFront={prevFront}
													prevBack={prevBack}
													nextFront={nextFront}
													nextBack={nextBack}
													onAnimatePrev={animatePrev}
													onAnimateNext={animateNext}
													onLayoutChange={(layout) => {
														setMediaLayout(layout);
														localStorage.setItem("bloom-media-layout", layout);
														invoke("save_setting", {
															key: "bloom-media-layout",
															value: layout
														}).catch(console.error);
														window.dispatchEvent(
															new CustomEvent("settings-changed", {
																detail: { key: "media-layout", value: layout }
															})
														);
													}}
												/>
											) : (
												<div className="compact-premium-layout">
													<div className="album-art-section">
														<motion.div
															className="premium-album-art"
															whileHover={{ scale: 1.05 }}
															whileTap={{ scale: 0.95 }}
															onClick={(e) => {
																e.stopPropagation();
																setMediaLayout("compact");
																localStorage.setItem("bloom-media-layout", "compact");
																invoke("save_setting", {
																	key: "bloom-media-layout",
																	value: "compact"
																}).catch(console.error);
																window.dispatchEvent(
																	new CustomEvent("settings-changed", {
																		detail: { key: "media-layout", value: "compact" }
																	})
																);
															}}
															style={{ cursor: "pointer" }}
														>
															<AnimatePresence mode="wait" initial={false}>
																{albumArtUrl ? (
																	<motion.img
																		key={`art-${albumArtKey}`}
																		src={albumArtUrl}
																		alt="Art"
																		initial={{ rotateY: 90, opacity: 0 }}
																		animate={{ rotateY: 0, opacity: 1 }}
																		exit={{ rotateY: -90, opacity: 0 }}
																		transition={{ duration: 0.3, ease: "easeInOut" }}
																		style={{ width: "100%", height: "100%", objectFit: "cover" }}
																	/>
																) : (
																	<motion.div
																		key="placeholder"
																		className="art-placeholder-mini"
																		initial={{ rotateY: 90, opacity: 0 }}
																		animate={{ rotateY: 0, opacity: 1 }}
																		exit={{ rotateY: -90, opacity: 0 }}
																		transition={{ duration: 0.3, ease: "easeInOut" }}
																	>
																		<MusicNoteIcon size={32} className="music-placeholder-svg" />
																	</motion.div>
																)}
															</AnimatePresence>
														</motion.div>
													</div>

													<div className="metadata-controls-section-middle">
														<div className="track-header-row">
															<div className="track-info-middle">
																<TitleMarquee title={mediaInfo.title} />
																<span className="premium-artist">{mediaInfo.artist}</span>
															</div>
															<div className="header-visualizer-wrap">
																<div className="header-visualizer">
																	<Visualizer isPlaying={isPlaying} bars={5} height={18} />
																</div>
																<motion.button
																	className="classic-audio-output-btn"
																	onClick={(e) => {
																		e.stopPropagation();
																		invoke("open_sound_settings").catch(() => {});
																	}}
																	whileTap={{ scale: 0.9 }}
																	title="Audio Output"
																>
																	<HeadphonesIcon size={20} style={{ opacity: 0.5 }} />
																</motion.button>
															</div>
														</div>

														<div className="controls-row-sleek">
															<motion.button
																className="sleek-btn previous-btn"
																onClick={(e) => {
																	e.stopPropagation();
																	animatePrev();
																}}
																whileHover={{ scale: 1.2 }}
																whileTap={{ scale: 0.9 }}
																transition={{ type: "spring", stiffness: 400, damping: 25 }}
															>
																<div
																	style={{
																		position: "relative",
																		width: 32,
																		height: 16,
																		overflow: "hidden"
																	}}
																>
																	<motion.div
																		animate={prevBack}
																		style={{
																			position: "absolute",
																			inset: 0,
																			display: "flex",
																			alignItems: "center",
																			justifyContent: "center"
																		}}
																	>
																		<SkipBackIcon size={32} />
																	</motion.div>
																	<motion.div
																		animate={prevFront}
																		style={{
																			position: "absolute",
																			inset: 0,
																			display: "flex",
																			alignItems: "center",
																			justifyContent: "center"
																		}}
																	>
																		<SkipBackIcon size={32} />
																	</motion.div>
																</div>
															</motion.button>

															<motion.button
																className="sleek-btn play-pause-btn-floating"
																onClick={(e) => {
																	e.stopPropagation();
																	togglePlayPause();
																}}
																whileHover={{ scale: 1.2 }}
																whileTap={{ scale: 0.95 }}
																transition={{ type: "spring", stiffness: 400, damping: 25 }}
															>
																<AnimatePresence mode="wait" initial={false}>
																	<motion.div
																		key={isPlaying ? "pause" : "play"}
																		initial={{ opacity: 0, scale: 0.8 }}
																		animate={{ opacity: 1, scale: 1 }}
																		exit={{ opacity: 0, scale: 0.8 }}
																		transition={{ duration: 0.15 }}
																		style={{
																			display: "flex",
																			alignItems: "center",
																			justifyContent: "center"
																		}}
																	>
																		{isPlaying ? <PauseIcon size={26} /> : <PlayIcon size={26} />}
																	</motion.div>
																</AnimatePresence>
															</motion.button>

															<motion.button
																className="sleek-btn next-btn"
																onClick={(e) => {
																	e.stopPropagation();
																	animateNext();
																}}
																whileHover={{ scale: 1.2 }}
																whileTap={{ scale: 0.9 }}
																transition={{ type: "spring", stiffness: 400, damping: 25 }}
															>
																<div
																	style={{
																		position: "relative",
																		width: 32,
																		height: 16,
																		overflow: "hidden"
																	}}
																>
																	<motion.div
																		animate={nextBack}
																		style={{
																			position: "absolute",
																			inset: 0,
																			display: "flex",
																			alignItems: "center",
																			justifyContent: "center"
																		}}
																	>
																		<SkipForwardIcon size={32} />
																	</motion.div>
																	<motion.div
																		animate={nextFront}
																		style={{
																			position: "absolute",
																			inset: 0,
																			display: "flex",
																			alignItems: "center",
																			justifyContent: "center"
																		}}
																	>
																		<SkipForwardIcon size={32} />
																	</motion.div>
																</div>
															</motion.button>
														</div>

														<div className="volume-slider-container">
															<VolumeLowIcon size={12} style={{ opacity: 0.5 }} />
															<div className="slider-track-premium">
																<input
																	type="range"
																	min="0"
																	max="1"
																	step="0.01"
																	aria-label="Volume"
																	value={displayVolume}
																	onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
																	onPointerDown={(e) => e.stopPropagation()}
																	onClick={(e) => e.stopPropagation()}
																	className="premium-slider"
																/>
																<div
																	className="slider-progress-fill"
																	style={{ width: `${displayVolume * 100}%` }}
																/>
															</div>
															<VolumeHighIcon size={14} style={{ opacity: 0.5 }} />
														</div>
													</div>
												</div>
											)}
										</motion.div>
									) : (
										<motion.div
											key="standard-view-group"
											initial={{ opacity: 0, y: -5 }}
											animate={{ opacity: 1, y: 0 }}
											exit={{ opacity: 0, y: 5, transition: { duration: 0.1 } }}
											transition={{ duration: 0.2 }}
											style={{ width: "100%" }}
										>
											<div
												className="main-row"
												// A device alert or notification covers the whole pill.
												style={bloomMode === "device" || deviceAlertOnScreen || bloomMode === "notification" || notificationAlertOnScreen ? { visibility: "hidden" } : undefined}
											>
												<AnimatePresence mode="wait">
													{(showPowerPulse || showLowBatteryPulse || showUpdatePulse) &&
													!isHovered ? (
														showUpdatePulse ? (
															<motion.div
																key="update-pulse-view"
																initial={{ opacity: 0, scale: 0.95, filter: "blur(4px)" }}
																animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
																exit={{ opacity: 0, scale: 1.05, filter: "blur(4px)" }}
																className="power-pulse-content"
															>
																<GreenDownArrowIcon />
																<span className="label" style={{ color: "#32D74B" }}>
																	Update Available
																</span>
															</motion.div>
														) : (
															<motion.div
																key="pulse-view"
																initial={{ opacity: 0, scale: 0.95, filter: "blur(4px)" }}
																animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
																exit={{ opacity: 0, scale: 1.05, filter: "blur(4px)" }}
																className="power-pulse-content"
															>
																{updateAvailable && <GreenDownArrowIcon />}
																<BatteryIcon
																	charging={isCharging}
																	level={batteryLevel}
																	threshold={lowBatteryThreshold}
																/>
																<span
																	className="label"
																	style={{ color: showLowBatteryPulse ? "#FF453A" : "inherit" }}
																>
																	{showLowBatteryPulse
																		? "Low Battery"
																		: isCharging
																			? "Charging"
																			: "On Battery"}{" "}
																	• {batteryLevel}%
																</span>
															</motion.div>
														)
													) : (
														<motion.div
															key="standard-view"
															className="main-row-inner"
															initial={{ opacity: 0 }}
															animate={{ opacity: 1 }}
															exit={{ opacity: 0 }}
														>
															{/* Left: music on hover while a paused session remains, otherwise status widgets */}
															<div className="side-content left">
																{showCompactMusicIcons && settingsVisualizerEnabled ? (
																	<AnimatePresence>
																		{settingsVisualizerEnabled && (
																			<motion.div
																				key="visualizer"
																				initial={{ scale: 0.8, opacity: 0 }}
																				animate={{ scale: 1, opacity: 1 }}
																				exit={{ scale: 0.8, opacity: 0 }}
																			>
																				<Visualizer isPlaying={isPlaying} />
																			</motion.div>
																		)}
																	</AnimatePresence>
																) : !showCompactMusicIcons && isHovered && statusWidgets.left.length > 0 ? (
																	<motion.div
																		key="left-widgets"
																		ref={leftWidgetsRef}
																		className="passive-features-group"
																		initial={{ opacity: 0 }}
																		animate={{ opacity: 1 }}
																		exit={{ opacity: 0 }}
																		transition={{ duration: 0.2 }}
																	>
																		{statusWidgets.left.map(renderStatusWidget)}
																	</motion.div>
																) : null}
															</div>

															{/* Center - Time (always visible) */}
															<div className="time-center" ref={timeCenterRef}>
																<AnimatePresence>
																	{showPanelArrows && (
																		<motion.button
																			key="panel-prev"
																			type="button"
																			className="panel-arrow prev"
																			aria-label="Previous panel"
																			initial={{ opacity: 0, x: 4 }}
																			animate={{ opacity: 1, x: 0 }}
																			exit={{ opacity: 0, x: 4 }}
																			transition={{ duration: 0.15 }}
																			onClick={(e) => {
																				e.stopPropagation();
																				cyclePanel(-1);
																			}}
																		>
																			<ChevronLeft size={12} strokeWidth={2.5} />
																		</motion.button>
																	)}
																</AnimatePresence>
																<div className="time-flip-container" onClick={toggleCalendarMode}>
																	<AnimatePresence initial={false}>
																		{timerSeconds > 0 || isTimerFinished ? (
																			<motion.span
																				key="timer"
																				className={`time compact-timer ${isTimerFinished ? "timer-finished" : ""}`}
																				initial={{ rotateX: -90, opacity: 0 }}
																				animate={{ rotateX: 0, opacity: 1 }}
																				exit={{ rotateX: 90, opacity: 0 }}
																				transition={{ type: "spring", stiffness: 600, damping: 30 }}
																			>
																				{isTimerFinished && (
																					<BellRing
																						size={13}
																						strokeWidth={2.5}
																						className="timer-bell"
																					/>
																				)}
																				{formatTimerTime(timerSeconds)}
																			</motion.span>
																		) : (
																			<motion.span
																				key="clock"
																				className="time"
																				initial={{ rotateX: -90, opacity: 0 }}
																				animate={{ rotateX: 0, opacity: 1 }}
																				exit={{ rotateX: 90, opacity: 0 }}
																				transition={{ type: "spring", stiffness: 600, damping: 30 }}
																			>
																				{time}
																			</motion.span>
																		)}
																	</AnimatePresence>
																</div>
																<AnimatePresence>
																	{showPanelArrows && (
																		<motion.button
																			key="panel-next"
																			type="button"
																			className="panel-arrow next"
																			aria-label="Next panel"
																			initial={{ opacity: 0, x: -4 }}
																			animate={{ opacity: 1, x: 0 }}
																			exit={{ opacity: 0, x: -4 }}
																			transition={{ duration: 0.15 }}
																			onClick={(e) => {
																				e.stopPropagation();
																				cyclePanel(1);
																			}}
																		>
																			<ChevronRight size={12} strokeWidth={2.5} />
																		</motion.button>
																	)}
																</AnimatePresence>
																{updateAvailable && showUpdateIndicator && (
																	<div className="update-dot" />
																)}
															</div>

															{/* Right: album art on a retained music session, otherwise status widgets */}
															<div className="side-content right">
																{showCompactMusicIcons && (settingsAlbumArtEnabled || showMusicOnStatusHover) ? (
																	<AnimatePresence mode="wait">
																		<motion.div
																			key="album-art"
																			className="album-art-glow-wrapper"
																			initial={{ opacity: 0, scale: 0.8 }}
																			animate={{ opacity: 1, scale: 1 }}
																			exit={{ opacity: 0, y: -20, scale: 0.8, filter: "blur(8px)" }}
																			transition={{ duration: 0.12 }}
																		>
																			{settingsAlbumArtEnabled && albumArtUrl && settingsCompactGlowEnabled && (
																				<img
																					src={albumArtUrl}
																					alt=""
																					className="album-art-glow-bg"
																					draggable={false}
																				/>
																			)}
																			<button
																				className={`album-art album-art-activity${!isPlaying ? " paused" : ""}`}
																				aria-label="Open music"
																				onClick={(e) => {
																					e.stopPropagation();
																					openNotch("music");
																				}}
																				onContextMenu={(e) => {
																					e.preventDefault();
																					e.stopPropagation();
																					skipPrevious();
																				}}
																			>
																				<div className="album-art-inner">
																					<AnimatePresence mode="wait" initial={false}>
																						{settingsAlbumArtEnabled && albumArtUrl ? (
																							<motion.img
																								key={`compact-art-${albumArtKey}`}
																								src={albumArtUrl}
																								alt="Art"
																								draggable={false}
																								initial={{ rotateY: 90, opacity: 0 }}
																								animate={{ rotateY: 0, opacity: 1 }}
																								exit={{ rotateY: -90, opacity: 0 }}
																								transition={{ duration: 0.25, ease: "easeInOut" }}
																								style={{
																									width: "100%",
																									height: "100%",
																									objectFit: "cover"
																								}}
																							/>
																						) : (
																							<motion.div
																								key="compact-placeholder"
																								className="album-art-placeholder"
																								initial={{ rotateY: 90, opacity: 0 }}
																								animate={{ rotateY: 0, opacity: 1 }}
																								exit={{ rotateY: -90, opacity: 0 }}
																								transition={{ duration: 0.25, ease: "easeInOut" }}
																							>
																								<MusicNoteIcon className="music-placeholder-svg-small" />
																							</motion.div>
																						)}
																					</AnimatePresence>
																				</div>
																			</button>
																		</motion.div>
																	</AnimatePresence>
																) : !showCompactMusicIcons && isHovered && statusWidgets.right.length > 0 ? (
																	<motion.div
																		key="right-widgets"
																		ref={rightWidgetsRef}
																		className="passive-features-group"
																		initial={{ opacity: 0 }}
																		animate={{ opacity: 1 }}
																		exit={{ opacity: 0 }}
																		transition={{ duration: 0.2 }}
																	>
																		{statusWidgets.right.map(renderStatusWidget)}
																	</motion.div>
																) : null}
															</div>
														</motion.div>
													)}
												</AnimatePresence>
											</div>
										</motion.div>
									)}
								</AnimatePresence>

								{/* Wi-Fi networks, opened from the controls panel's Wi-Fi tile */}
								<AnimatePresence>
									{bloomMode === "wifi" && (
										<motion.div
											key="wifi-view"
											initial={{ opacity: 0 }}
											animate={{ opacity: 1 }}
											exit={{ opacity: 0, filter: "blur(4px)", transition: { duration: 0.1 } }}
											transition={{ type: "spring", stiffness: 400, damping: 30 }}
										>
											<WifiPanel
												enabled={wifiEnabled}
												onToggle={toggleWifi}
												onBack={() => setBloomMode("command-center")}
												onPinChange={setNotchPinned}
											/>
										</motion.div>
									)}
								</AnimatePresence>

								{/* Bluetooth devices, opened from the controls panel's Bluetooth tile */}
								<AnimatePresence>
									{bloomMode === "bluetooth" && (
										<motion.div
											key="bluetooth-view"
											initial={{ opacity: 0 }}
											animate={{ opacity: 1 }}
											exit={{ opacity: 0, filter: "blur(4px)", transition: { duration: 0.1 } }}
											transition={{ type: "spring", stiffness: 400, damping: 30 }}
										>
											<BluetoothPanel
												enabled={bluetoothEnabled}
												onToggle={toggleBluetooth}
												onBack={() => setBloomMode("command-center")}
												onPinChange={setNotchPinned}
											/>
										</motion.div>
									)}
								</AnimatePresence>

								{/* Connected devices: everything connected, with its battery, by priority */}
								<AnimatePresence>
									{bloomMode === "devices" && (
										<motion.div
											key="devices-view"
											initial={{ opacity: 0 }}
											animate={{ opacity: 1 }}
											exit={{ opacity: 0, filter: "blur(4px)", transition: { duration: 0.1 } }}
											transition={{ type: "spring", stiffness: 400, damping: 30 }}
										>
											<ConnectedDevicesPanel
												data={connectedDevices}
												height={devicesPanelHeight}
												buds={budsById}
												lowThreshold={lowBatteryThreshold}
												onContentHeight={setDevicesContentHeight}
											/>
										</motion.div>
									)}
								</AnimatePresence>

								{/* Command Center Panel */}
								<AnimatePresence>
									{bloomMode === "command-center" && (
										<motion.div
											className="command-center-content-minimal"
											onClick={(e) => e.stopPropagation()}
											initial={{ opacity: 0 }}
											animate={{ opacity: 1 }}
											exit={{ opacity: 0, filter: "blur(4px)", transition: { duration: 0.1 } }}
											transition={{ type: "spring", stiffness: 400, damping: 30 }}
										>
											{/* Pills Grid */}
											<div className="cc-pills-grid">
												{/* Wi-Fi Pill */}
												<div
													className={`cc-pill-tile ${wifiEnabled ? "active" : ""}`}
													onClick={(e) => {
														e.stopPropagation();
														toggleWifi();
													}}
													onContextMenu={handleWifiRightClick}
													title="Left-click to toggle, Right-click for networks"
												>
													<div className="cc-pill-icon-wrapper">
														<WifiIcon enabled={wifiEnabled} connected={wifiConnected} />
													</div>
													<div className="cc-pill-info">
														<span className="cc-pill-title">Wi-Fi</span>
														<span className="cc-pill-status">
															{wifiStatus === null
																? "…"
																: !wifiEnabled
																	? "Off"
																	: wifiConnected
																		? (wifiStatus?.ssid ?? "Connected")
																		: "Not connected"}
														</span>
													</div>
													<button
														className="cc-pill-more"
														aria-label="Wi-Fi networks"
														title="Wi-Fi networks"
														onClick={(e) => {
															e.stopPropagation();
															setBloomMode("wifi");
														}}
													>
														<ChevronRight />
													</button>
												</div>

												{/* Dock Mode Pill */}
												<div
													className={`cc-pill-tile ${dockMode === "fixed" ? "active" : ""}`}
													onClick={toggleDockModeSetting}
													title="Cycle dock mode: Fixed / Smart / Peek"
												>
													<div className="cc-pill-icon-wrapper">
														<DockIcon />
													</div>
													<div className="cc-pill-info">
														<span className="cc-pill-title">Dock Mode</span>
														<span className="cc-pill-status">
															{dockMode === "fixed"
																? "Fixed"
																: dockMode === "smart"
																	? "Smart"
																	: "Peek"}
														</span>
													</div>
												</div>

												{/* Bluetooth Pill */}
												<div
													className={`cc-pill-tile ${bluetoothEnabled ? "active" : ""}`}
													onClick={(e) => {
														e.stopPropagation();
														toggleBluetooth();
													}}
													onContextMenu={handleBluetoothRightClick}
													title="Left-click to toggle, Right-click for devices"
												>
													<div className="cc-pill-icon-wrapper">
														<BluetoothIcon />
													</div>
													<div className="cc-pill-info">
														<span className="cc-pill-title">Bluetooth</span>
														<span className="cc-pill-status">
															{!bluetoothEnabled
																? "Off"
																: btConnectedNames.length === 1
																	? btConnectedNames[0]
																	: btConnectedNames.length > 1
																		? `${btConnectedNames.length} connected`
																		: "On"}
														</span>
													</div>
													<button
														className="cc-pill-more"
														aria-label="Bluetooth devices"
														title="Bluetooth devices"
														onClick={(e) => {
															e.stopPropagation();
															setBloomMode("bluetooth");
														}}
													>
														<ChevronRight />
													</button>
												</div>

												{/* Notch Mode Pill */}
												<div
													className={`cc-pill-tile ${notchMode === "fixed" ? "active" : ""}`}
													onClick={toggleNotchModeSetting}
													title="Cycle notch mode: Fixed / Smart / Peek"
												>
													<div className="cc-pill-icon-wrapper">
														<NotchIcon />
													</div>
													<div className="cc-pill-info">
														<span className="cc-pill-title">Notch Mode</span>
														<span className="cc-pill-status">
															{notchMode === "fixed"
																? "Fixed"
																: notchMode === "smart"
																	? "Smart"
																	: "Peek"}
														</span>
													</div>
												</div>
											</div>

											{/* Circular Actions Row */}
											<div className="cc-circular-actions-row">
												<button
													className="cc-circular-btn"
													onClick={(e) => {
														e.stopPropagation();
														invoke("open_app", { appName: "ms-settings:notifications" }).catch(
															console.error
														);
													}}
													title="Do Not Disturb — Open Windows notification settings"
												>
													<MoonIcon />
												</button>
												<button
													className={`cc-circular-btn ${batterySaverEnabled ? "active" : ""}`}
													onClick={(e) => {
														e.stopPropagation();
														openBatterySaverSettings();
													}}
													title={`Energy Saver: ${batterySaverEnabled ? "On" : "Off"} — Click to open Settings`}
												>
													<BatterySaverIcon />
												</button>
												<button
													className="cc-circular-btn"
													onClick={(e) => {
														e.stopPropagation();
														openSystemTray(e);
													}}
													title="System Tray"
												>
													<TrayIcon />
												</button>
												<button
													className="cc-circular-btn"
													onClick={(e) => {
														e.stopPropagation();
														invoke("open_notification_center");
													}}
													title="Notification Center"
												>
													<BellIcon />
												</button>
												<button
													className="cc-circular-btn"
													onClick={(e) => {
														e.stopPropagation();
														openSettingsWindow();
													}}
													title="Awaken Settings"
												>
													<SettingsIcon />
												</button>
												<button
													className="cc-circular-btn"
													onClick={(e) => {
														e.stopPropagation();
														invoke("restart_bloom");
													}}
													title="Restart Awaken"
												>
													<ReloadIcon />
												</button>
											</div>

											{/* Classic Sliders Area */}
											<div className="cc-classic-sliders-area">
												{/* Volume Slider */}
												<div className="cc-classic-slider-row">
													<div className="cc-classic-slider-label">
														<button
															type="button"
															className="cc-level-toggle"
															onClick={toggleVolumeLevel}
															aria-label={displayVolume > 0 ? "Mute volume" : "Restore volume"}
															aria-pressed={displayVolume === 0}
															title={displayVolume > 0 ? "Mute volume" : "Restore volume"}
														>
															<CommandVolumeIcon />
														</button>
														<span>Volume</span>
													</div>
													<div className="cc-classic-slider-track">
														<input
															type="range"
															min="0"
															max="1"
															step="0.01"
															aria-label="Volume"
															value={displayVolume}
															onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
															onPointerDown={(e) => e.stopPropagation()}
															onClick={(e) => e.stopPropagation()}
															className="cc-classic-input"
														/>
														<div
															className="cc-classic-fill"
															style={{ width: `${displayVolume * 100}%` }}
														/>
													</div>
													<span className="cc-classic-percentage">
														{Math.round(displayVolume * 100)}%
													</span>
												</div>

												{/* Brightness Slider */}
												<div className="cc-classic-slider-row">
													<div className="cc-classic-slider-label">
														<button
															type="button"
															className="cc-level-toggle"
															onClick={toggleBrightnessLevel}
															aria-label={
																currentBrightness > 0 ? "Minimize brightness" : "Restore brightness"
															}
															aria-pressed={currentBrightness === 0}
															title={
																currentBrightness > 0 ? "Minimize brightness" : "Restore brightness"
															}
														>
															<CommandBrightnessIcon />
														</button>
														<span>Brightness</span>
													</div>
													<div className="cc-classic-slider-track">
														<input
															type="range"
															min="0"
															max="100"
															step="1"
															aria-label="Brightness"
															value={currentBrightness}
															onChange={(e) => handleBrightnessChange(parseInt(e.target.value))}
															onPointerDown={(e) => e.stopPropagation()}
															onClick={(e) => e.stopPropagation()}
															className="cc-classic-input"
														/>
														<div
															className="cc-classic-fill"
															style={{ width: `${currentBrightness}%` }}
														/>
													</div>
													<span className="cc-classic-percentage">{currentBrightness}%</span>
												</div>
											</div>
										</motion.div>
									)}
								</AnimatePresence>

								{/* Device alert: a device connected or disconnected. A
								    click opens the Bluetooth view. */}
								<AnimatePresence
									// An alert arriving while the last one fades out keeps the
									// clock row hidden.
									onExitComplete={() => setDeviceAlertOnScreen(deviceAlertRef.current !== null)}
								>
									{bloomMode === "device" && deviceAlert && (
										<motion.div
											className="device-alert"
											onClick={(e) => {
												e.stopPropagation();
												const usb = deviceAlert.usb;
												deviceAlertQueueRef.current = [];
												setDeviceAlert(null);
												// Bluetooth devices open their list; USB ones
												// have none, so the click just dismisses.
												if (usb) return;
												setIsOpen(true);
												setBloomMode("bluetooth");
											}}
											initial={{ opacity: 0 }}
											animate={{ opacity: 1 }}
											exit={{ opacity: 0, filter: "blur(4px)", transition: { duration: 0.12 } }}
											transition={{ duration: 0.2 }}
										>
											<DeviceArt
												art={deviceAlert.art}
												phase={deviceAlert.connected ? "play" : "leave"}
												runId={deviceAlert.runId}
												size={60}
											/>
											<div className="device-alert-text">
												<span className="device-alert-name">{deviceAlert.name}</span>
												<span className="device-alert-status">
													{deviceAlertStatus(deviceAlert.art, deviceAlert.connected, deviceAlert.usb)}
												</span>
											</div>
											{deviceAlert.connected && deviceAlert.buds ? (
												<DeviceBudsBattery buds={deviceAlert.buds} />
											) : (
												deviceAlert.connected &&
												deviceAlert.battery !== null && <DeviceBatteryRing level={deviceAlert.battery} />
											)}
										</motion.div>
									)}
								</AnimatePresence>

								{/* Notification alert banner: WhatsApp, Telegram, Discord, Antigravity, Claude, etc. */}
								<AnimatePresence
									onExitComplete={() =>
										setNotificationAlertOnScreen(
											activeNotificationRef.current !== null || notificationQueueRef.current.length > 0
										)
									}
								>
									{bloomMode === "notification" && activeNotification && (
										<motion.div
											className="notification-island-alert"
											initial={{ opacity: 0, scale: 0.94, y: -4 }}
											animate={{ opacity: 1, scale: 1, y: 0 }}
											exit={{
												opacity: 0,
												scale: 0.94,
												filter: "blur(4px)",
												transition: { duration: 0.15 }
											}}
											transition={{ type: "spring", stiffness: 420, damping: 28 }}
											onClick={(e) => {
												e.stopPropagation();
												invoke("focus_notification_app", {
													appName: activeNotification.app_name,
													appId: activeNotification.app_id
												}).catch(() => {});
												dismissActiveNotification();
											}}
											onMouseEnter={() => {
												if (notificationAlertTimerRef.current)
													clearTimeout(notificationAlertTimerRef.current);
											}}
											onMouseLeave={() => {
												if (notificationAlertTimerRef.current)
													clearTimeout(notificationAlertTimerRef.current);
												notificationAlertTimerRef.current = setTimeout(() => {
													dismissActiveNotification();
												}, 3000);
											}}
										>
											<div className="notification-island-badge">
												<AppBrandIcon
													appName={activeNotification.app_name}
													appId={activeNotification.app_id}
												/>
											</div>
											<div className="notification-island-text">
												<div className="notification-island-top">
													<span className="notification-island-app">
														{activeNotification.app_name}
													</span>
													<span className="notification-island-dot">•</span>
													<span className="notification-island-time">now</span>
												</div>
												<div className="notification-island-title">
													{activeNotification.title}
												</div>
												{activeNotification.body ? (
													<div className="notification-island-body">
														{activeNotification.body}
													</div>
												) : null}
											</div>
											<button
												type="button"
												className="notification-island-close"
												onClick={(e) => {
													e.stopPropagation();
													invoke("dismiss_notification", { id: activeNotification.id }).catch(() => {});
													dismissActiveNotification();
												}}
												aria-label="Dismiss notification"
											>
												<X size={13} strokeWidth={2.4} />
											</button>
										</motion.div>
									)}
								</AnimatePresence>

								{/* Announcement Card */}
								<AnimatePresence>
									{bloomMode === "announcement" && announcement && !announcementDismissed && (
										<motion.div
											className={`announcement-content severity-${announcement.severity}`}
											onClick={(e) => e.stopPropagation()}
											initial={{ opacity: 0 }}
											animate={{ opacity: 1 }}
											exit={{
												opacity: 0,
												filter: "blur(4px)",
												transition: { duration: 0.1 }
											}}
											transition={{ type: "spring", stiffness: 400, damping: 30 }}
										>
											<div className="announcement-header">
												<div className="announcement-heading">
													<Megaphone size={14} className="announcement-icon" />
													<span className="announcement-title">{announcement.title}</span>
												</div>
												<button
													className="announcement-close"
													onClick={dismissAnnouncement}
													title="Dismiss"
												>
													<X size={13} strokeWidth={2.2} />
												</button>
											</div>
											{announcement.body && (
												<p className="announcement-body">{announcement.body}</p>
											)}
											{announcement.url && (
												<button
													className="announcement-link"
													onClick={() => openUrl(announcement.url!)}
												>
													Learn more
												</button>
											)}
										</motion.div>
									)}
								</AnimatePresence>

								{/* Calendar & Timer Split View */}
								<AnimatePresence>
									{settingsCalendarEnabled && isCalendarMode && (
										<motion.div
											className="calendar-timer-content split-view"
											onClick={(e) =>
												e.stopPropagation()
											} /* Block mode switches when clicking inside */
											initial={{ opacity: 0 }}
											animate={{ opacity: 1 }}
											exit={{ opacity: 0, filter: "blur(4px)", transition: { duration: 0.1 } }}
											transition={{ type: "spring", stiffness: 400, damping: 30 }}
										>
											<div className="calendar-column">
												<Calendar mondayFirst={calendarMondayFirst} month={calendarMonth} onMonthChange={setCalendarMonth} />
											</div>

											<div className="timer-column">
												<div className={`timer-section-new state-${timerState}`}>
													<div className="timer-main">
														<div className="timer-status">
															{isEditingTimer
																? "Type to set duration"
																: isTimerFinished
																	? "Time's up"
																	: timerEndTime
																		? `${timerState === "paused" ? "Paused · " : ""}ends ${timerEndTime}`
																		: "Click to edit"}
														</div>

														<div className={`timer-clock-row ${isEditingTimer ? "editing" : ""}`}>
															<div
																className={`timer-clock ${isEditingTimer && !timerEditValid ? "invalid" : ""}`}
																onClick={beginTimerEdit}
																title={isTimerRunning ? undefined : "Click to set a duration"}
															>
																{minuteDigitItems.map(({ digit, key }) => (
																	<RollDigit key={key} value={digit} compact={clockCompact} />
																))}
																<span className="timer-colon">:</span>
																{secondDigitItems.map(({ digit, key }) => (
																	<RollDigit key={key} value={digit} compact={clockCompact} />
																))}
															</div>
															<span className="timer-edit-underline" aria-hidden="true" />
															{isEditingTimer && (
																<input
																	ref={timerInputRef}
																	className="timer-edit-input"
																	type="text"
																	inputMode="numeric"
																	aria-label="Set timer duration as minutes and seconds, for example 1230 for 12 minutes 30 seconds"
																	maxLength={5}
																	aria-invalid={!timerEditValid}
																	value={timerEditDigits}
																	onChange={(e) =>
																		setTimerEditDigits(
																			e.target.value.replace(/\D/g, "").slice(0, 5)
																		)
																	}
																	onKeyDown={(e) => {
																		if (e.key === "Enter") commitTimerEdit(true);
																		if (e.key === "Escape") {
																			timerEditActiveRef.current = false;
																			setIsEditingTimer(false);
																		}
																	}}
																	onBlur={() => commitTimerEdit(false)}
																	onWheel={(e) => e.stopPropagation()}
																/>
															)}
														</div>
													</div>

													<div className="timer-controls-row">
														<span className="timer-controls-spacer" aria-hidden="true" />
														<button
															onClick={handlePrimaryTimerAction}
															onMouseDown={(e) => e.preventDefault()}
															className="timer-btn-play"
															title={primaryTimerLabel}
														>
															{isTimerRunning ? (
																<Pause size={14} strokeWidth={2} fill="currentColor" />
															) : (
																<Play size={14} strokeWidth={2} fill="currentColor" />
															)}
															<span>{primaryTimerLabel}</span>
														</button>
														<button
															onClick={resetTimer}
															className="timer-btn-reset"
															disabled={timerSeconds === 0 && !isTimerFinished}
															title="Reset"
														>
															<RotateCcw size={14} strokeWidth={2.5} />
														</button>
													</div>

													<div className="timer-preset-group">
														{[5, 15, 25, 50].map((mins) => (
															<button
																key={mins}
																onClick={() => startTimer(mins * 60)}
																className={`timer-preset-segment ${lastDurationSeconds === mins * 60 && !isTimerFinished ? "active" : ""}`}
															>
																{mins}m
															</button>
														))}
													</div>
												</div>
											</div>
										</motion.div>
									)}
								</AnimatePresence>

								{/* Shelf Panel */}
								<AnimatePresence>
									{bloomMode === "shelf" && (
										<motion.div
											className="shelf-content"
											onClick={(e) => e.stopPropagation()}
											onWheel={handleShelfWheel}
											initial={{ opacity: 0 }}
											animate={{ opacity: 1 }}
											exit={{ opacity: 0, filter: "blur(4px)", transition: { duration: 0.1 } }}
											transition={{ type: "spring", stiffness: 400, damping: 30 }}
										>
											{shelfNotice && <div className="shelf-notice">{shelfNotice}</div>}
											<div className="shelf-header-clean">
												<div className="shelf-header-title">
													<Inbox size={13} strokeWidth={2.2} />
													<span>Drop Shelf</span>
													{shelfItems.length > 0 && <span className="shelf-header-badge">{shelfItems.length}</span>}
												</div>
												{shelfItems.length > 0 && (
													<button
														type="button"
														className="shelf-clear-btn"
														onClick={() => {
															setShelfItems([]);
															if (shelfPersist) localStorage.removeItem("bloom-shelf-items");
														}}
														title="Clear shelf files"
													>
														<Trash2 size={12} />
														<span>Clear</span>
													</button>
												)}
											</div>
											{shelfItems.length === 0 ? (
												<div className="shelf-empty">
													<span>Drop files or selected text here</span>
												</div>
											) : (
													<div
														className={`shelf-items-grid ${shelfOverflowing ? "overflowing" : ""}`}
														ref={shelfGridRef}
													>
														<AnimatePresence mode="popLayout" onExitComplete={measureShelfOverflow}>
															{shelfItems.map((item) => {
																const preview = item.path ? shelfThumbs[item.path] : undefined;
																const thumb = preview?.thumb;
																return (
																	<motion.div
																		key={item.id}
																		layout
																		initial={
																			shelfNewIdsRef.current.has(item.id)
																				? { opacity: 0, scale: 0.82 }
																				: false
																		}
																		animate={{ opacity: 1, scale: 1 }}
																		exit={{
																			opacity: 0,
																			scale: 0.82,
																			transition: { duration: 0.16, ease: "easeOut" }
																		}}
																		transition={{
																			type: "spring",
																			stiffness: 520,
																			damping: 38,
																			mass: 0.7
																		}}
																		className={`shelf-tile ${item.type === "text" || (!thumb && preview?.text) ? "is-text" : ""}`}
																		title={
																			item.type === "text" ? item.text?.slice(0, 1000) : item.path
																		}
																		onPointerDown={(e) => handleShelfPointerDown(e, item)}
																		onPointerMove={(e) => handleShelfPointerMove(e, item)}
																		onClick={(e) => handleShelfTileClick(e, item)}
																	>
																		<div className="shelf-tile-preview">
																			{item.type === "text" ? (
																				<div className="shelf-tile-text">
																					<Type
																						size={11}
																						strokeWidth={2}
																						className="shelf-tile-text-icon"
																					/>
																					<span className="shelf-tile-text-body">{item.text}</span>
																				</div>
																			) : !thumb && preview?.text ? (
																				<div className="shelf-tile-text">
																					<ShelfTypeIcon
																						name={item.name}
																						folder={false}
																						size={11}
																						className="shelf-tile-text-icon"
																					/>
																					<span className="shelf-tile-text-body">{preview.text}</span>
																				</div>
																			) : (
																				<>
																					<div className="shelf-tile-placeholder">
																						{preview && !thumb ? (
																							<ShelfTypeIcon
																								name={item.name}
																								folder={preview.folder}
																							/>
																						) : null}
																					</div>
																					{thumb ? (
																						<img src={thumb} alt="" draggable={false} />
																					) : null}
																				</>
																			)}
																		</div>
																		<span className="shelf-tile-name">
																			{item.type === "text"
																				? `Text · ${item.text?.length ?? 0} chars`
																				: item.name}
																		</span>
																		<button
																			className="shelf-tile-remove"
																			title="Remove from shelf"
																			onClick={(e) => {
																				e.stopPropagation();
																				removeShelfItem(item.id);
																			}}
																		>
																			<X size={11} strokeWidth={2.5} />
																		</button>
																	</motion.div>
																);
															})}
														</AnimatePresence>
													</div>
												)}
										</motion.div>
									)}
								</AnimatePresence>

								{/* Clipboard Stream Panel */}
								<AnimatePresence>
									{bloomMode === "clipboard" && (
										<motion.div
											className="clipboard-content"
											onClick={(e) => e.stopPropagation()}
											initial={{ opacity: 0 }}
											animate={{ opacity: 1 }}
											exit={{ opacity: 0, filter: "blur(4px)", transition: { duration: 0.1 } }}
											transition={{ type: "spring", stiffness: 400, damping: 30 }}
										>
											{zoomedImageItem ? (
												<div className="clip-image-viewer">
													<div className="clip-image-viewer-header">
														<button
															type="button"
															className="clip-image-viewer-back-btn"
															onClick={() => setZoomedImageItem(null)}
															title="Back to clipboard list"
														>
															<ChevronLeft size={14} strokeWidth={2.5} />
															<span>Back</span>
														</button>
														<div className="clip-image-viewer-dims">
															{zoomedImageItem.width && zoomedImageItem.height
																? `${zoomedImageItem.width} × ${zoomedImageItem.height} px`
																: "Image Clip"}
														</div>
														<div className="clip-image-viewer-actions">
															<button
																type="button"
																className="clip-image-viewer-tool-btn"
																onClick={() => setImageZoomLevel((z) => Math.max(0.5, Math.round((z - 0.25) * 100) / 100))}
																title="Zoom out"
																disabled={imageZoomLevel <= 0.5}
															>
																<ZoomOut size={12} strokeWidth={2.4} />
															</button>
															<button
																type="button"
																className="clip-image-viewer-tool-btn zoom-val"
																onClick={() => setImageZoomLevel(1)}
																title="Reset zoom to 100%"
															>
																<span>{Math.round(imageZoomLevel * 100)}%</span>
															</button>
															<button
																type="button"
																className="clip-image-viewer-tool-btn"
																onClick={() => setImageZoomLevel((z) => Math.min(3, Math.round((z + 0.25) * 100) / 100))}
																title="Zoom in"
																disabled={imageZoomLevel >= 3}
															>
																<ZoomIn size={12} strokeWidth={2.4} />
															</button>
															<button
																type="button"
																className={`clip-image-viewer-copy-btn ${copiedId === zoomedImageItem.id ? "copied" : ""}`}
																onClick={async () => {
																	try {
																		await invoke("copy_clipboard_item", { id: zoomedImageItem.id });
																	} catch (_) {}
																	setCopiedId(zoomedImageItem.id);
																	setTimeout(() => setCopiedId(null), 1200);
																}}
																title="Copy image to clipboard"
															>
																{copiedId === zoomedImageItem.id ? (
																	<>
																		<Check size={11} strokeWidth={3} />
																		<span>Copied</span>
																	</>
																) : (
																	<>
																		<Copy size={11} strokeWidth={2.4} />
																		<span>Copy</span>
																	</>
																)}
															</button>
														</div>
													</div>
													<div
														className="clip-image-viewer-stage"
														onWheel={(e) => {
															e.stopPropagation();
															if (e.deltaY < 0) {
																setImageZoomLevel((z) => Math.min(3, Math.round((z + 0.2) * 100) / 100));
															} else if (e.deltaY > 0) {
																setImageZoomLevel((z) => Math.max(0.5, Math.round((z - 0.2) * 100) / 100));
															}
														}}
													>
														<div
															className="clip-image-viewer-viewport"
															style={{
																transform: `scale(${imageZoomLevel})`,
																cursor: imageZoomLevel > 1 ? "grab" : "zoom-in"
															}}
															onClick={() => setImageZoomLevel((z) => (z >= 2 ? 1 : z + 0.5))}
														>
															<img
																src={zoomedImageItem.content}
																alt="Zoomed Clip"
																className="clip-image-viewer-img"
																draggable={false}
															/>
														</div>
													</div>
												</div>
											) : (
												<>
													<div className="shelf-header-clean">
														<div className="shelf-header-title">
															<Clipboard size={13} strokeWidth={2.2} />
															<span>Clipboard</span>
															{clipboardItems.length > 0 && <span className="shelf-header-badge">{clipboardItems.length}</span>}
														</div>
														{clipboardItems.length > 0 && (
															<button
																type="button"
																className="shelf-clear-btn"
																onClick={() => invoke("clear_clipboard_history").catch(() => {})}
																title="Clear clipboard history"
															>
																<Trash2 size={12} />
																<span>Clear</span>
															</button>
														)}
													</div>
													{clipboardItems.length === 0 ? (
														<div className="shelf-empty">
															<span>No recent clips yet — copy text, links, or images</span>
														</div>
													) : (
														<div className="clip-stream-grid">
															<AnimatePresence mode="popLayout">
																{clipboardItems.map((item) => {
																	const isCopied = copiedId === item.id;
																	const isImage = item.kind === "image";
																	const getClipSnippet = () => {
																		if (isImage) {
																			return item.width && item.height
																				? `Image ${item.width}×${item.height}`
																				: "Copied Image";
																		}
																		if (item.kind === "hex") return item.content;
																		if (item.kind === "url") {
																			try {
																				const u = new URL(
																					item.content.startsWith("http")
																						? item.content
																						: `https://${item.content}`
																				);
																				const host = u.hostname.replace(/^www\./, "");
																				const path = u.pathname.replace(/\/$/, "");
																				return path && path !== "/" ? `${host}${path}` : host;
																			} catch {
																				return item.content.slice(0, 22);
																			}
																		}
																		const words = item.content.trim().split(/\s+/).filter(Boolean);
																		if (words.length <= 5) return words.join(" ");
																		return words.slice(0, 5).join(" ") + "…";
																	};
																	return (
																		<motion.div
																			key={item.id}
																			layout
																			initial={{ opacity: 0, scale: 0.94 }}
																			animate={{ opacity: 1, scale: 1 }}
																			exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.1 } }}
																			className={`clip-cell ${isImage ? "is-image" : ""} ${isCopied ? "copied" : ""}`}
																			onClick={async (e) => {
																				e.stopPropagation();
																				try {
																					await invoke("copy_clipboard_item", { id: item.id });
																				} catch (_) {
																					if (!isImage) {
																						try {
																							await writeText(item.content);
																						} catch {
																							await navigator.clipboard.writeText(item.content).catch(() => {});
																						}
																					}
																				}
																				setCopiedId(item.id);
																				setTimeout(() => {
																					setCopiedId(null);
																					releaseNotchHover();
																				}, 700);
																			}}
																		>
																			{isImage ? (
																				<div
																					className="clip-cell-thumb-wrap"
																					onClick={(e) => {
																						e.stopPropagation();
																						setZoomedImageItem(item);
																						setImageZoomLevel(1);
																					}}
																					title="Click to zoom image"
																				>
																					<img
																						src={item.content}
																						className="clip-cell-thumb"
																						alt="Clip"
																						draggable={false}
																					/>
																					<div className="clip-cell-thumb-zoom-badge">
																						<Maximize2 size={9} strokeWidth={2.8} />
																					</div>
																				</div>
																			) : item.kind === "hex" ? (
																				<span
																					className="clip-cell-swatch"
																					style={{ background: item.content }}
																				/>
																			) : item.kind === "url" ? (
																				<span className="clip-cell-icon url">
																					<Globe size={11} strokeWidth={2.4} />
																				</span>
																			) : item.kind === "code" ? (
																				<span className="clip-cell-icon code">
																					<Code size={11} strokeWidth={2.4} />
																				</span>
																			) : (
																				<span className="clip-cell-icon text">
																					<FileText size={11} strokeWidth={2.4} />
																				</span>
																			)}

																			<span className={`clip-cell-text ${item.kind}`}>
																				{getClipSnippet()}
																			</span>

																			{isCopied ? (
																				<span className="clip-cell-copied">
																					<Check size={10} strokeWidth={2.8} />
																					<span>Copied</span>
																				</span>
																			) : (
																				<div className="clip-cell-actions">
																					{isImage && (
																						<button
																							type="button"
																							className="clip-cell-zoom"
																							title="Zoom image"
																							onClick={(e) => {
																								e.stopPropagation();
																								setZoomedImageItem(item);
																								setImageZoomLevel(1);
																							}}
																						>
																							<Maximize2 size={10} strokeWidth={2.5} />
																						</button>
																					)}
																					<button
																						type="button"
																						className="clip-cell-delete"
																						title="Remove clip"
																						onClick={(e) => {
																							e.stopPropagation();
																							invoke("remove_clipboard_item", { id: item.id }).catch(() => {});
																						}}
																					>
																						<X size={10} strokeWidth={2.5} />
																					</button>
																				</div>
																			)}
																		</motion.div>
																	);
																})}
															</AnimatePresence>
														</div>
													)}
												</>
											)}
										</motion.div>
									)}
								</AnimatePresence>

								{/* Notification Center Panel */}
								<AnimatePresence>
									{bloomMode === "notifications" && (
										<motion.div
											className="notification-center-content"
											onClick={(e) => e.stopPropagation()}
											initial={{ opacity: 0 }}
											animate={{ opacity: 1 }}
											exit={{ opacity: 0, filter: "blur(4px)", transition: { duration: 0.1 } }}
											transition={{ type: "spring", stiffness: 400, damping: 30 }}
										>
											<div className="notif-center-header">
												<div className="notif-center-title-group">
													<BellRing size={13} className="notif-center-icon" />
													<span className="notif-center-title">Notifications</span>
													{notificationHistory.length > 0 && (
														<span className="notif-center-badge">{notificationHistory.length}</span>
													)}
												</div>
												<div className="notif-center-actions">
													{notificationHistory.length > 0 && (
														<button
															type="button"
															className="notif-center-clear-btn"
															onClick={clearAllNotifications}
															title="Clear all notifications"
														>
															<Trash2 size={12} strokeWidth={2.2} />
															<span>Clear all</span>
														</button>
													)}
													<button
														type="button"
														className="notif-center-close-btn"
														onClick={() => {
															setIsOpen(false);
															setBloomMode(collapsedMode);
														}}
														title="Close"
													>
														<X size={13} strokeWidth={2.4} />
													</button>
												</div>
											</div>

											{notificationHistory.length === 0 ? (
												<div className="notif-center-empty">
													<div className="notif-center-empty-icon">
														<Bell size={22} strokeWidth={1.8} />
													</div>
													<div className="notif-center-empty-title">No Notifications</div>
													<div className="notif-center-empty-subtitle">You're all caught up!</div>
												</div>
											) : (
												<div
													className="notif-center-list"
													onWheel={(e) => {
														e.stopPropagation();
														e.currentTarget.scrollTop += e.deltaY;
													}}
												>
													<AnimatePresence mode="popLayout">
														{notificationHistory.map((item) => (
															<motion.div
																key={item.id}
																className="notif-card"
																layout
																initial={{ opacity: 0, y: -4 }}
																animate={{ opacity: 1, y: 0 }}
																exit={{ opacity: 0, scale: 0.95 }}
																transition={{ duration: 0.15 }}
																onClick={() => {
																	invoke("focus_notification_app", {
																		appName: item.app_name,
																		appId: item.app_id
																	}).catch(() => {});
																	setIsOpen(false);
																	setBloomMode(collapsedMode);
																}}
															>
																<div className="notif-card-badge">
																	<AppBrandIcon appName={item.app_name} appId={item.app_id} />
																</div>
																<div className="notif-card-content">
																	<div className="notif-card-top">
																		<span className="notif-card-app">{item.app_name}</span>
																		<span className="notif-card-dot">•</span>
																		<span className="notif-card-time">
																			{formatRelativeTime(item.timestamp)}
																		</span>
																	</div>
																	<div className="notif-card-title">{item.title}</div>
																	{item.body ? <div className="notif-card-body">{item.body}</div> : null}
																</div>
																<button
																	type="button"
																	className="notif-card-delete-btn"
																	onClick={(e) => {
																		e.stopPropagation();
																		deleteNotification(item.id);
																	}}
																	title="Remove notification"
																>
																	<X size={11} strokeWidth={2.4} />
																</button>
															</motion.div>
														))}
													</AnimatePresence>
												</div>
											)}
										</motion.div>
									)}
								</AnimatePresence>
							</motion.div>
						)}
					</AnimatePresence>
				</motion.div>
				{/* The shelf's items, as a bubble on the left of the collapsed pill */}
				<AnimatePresence onExitComplete={() => reportNotchRect.current()}>
					{showShelfBubble && (
						<motion.button
							key="shelf-bubble"
							ref={shelfBubbleRef}
							type="button"
							className={`activity-bubble shelf-bubble ${isHovered ? "expanded" : ""}`}
							aria-label={`Open shelf: ${shelfItems.length} item${shelfItems.length === 1 ? "" : "s"}`}
							// Anchored at the pill's centre, offset past its left edge.
							style={{ right: "50%" }}
							initial={{ opacity: 0, scale: 0.4, x: 28, marginRight: getDynamicWidth() / 2 + 8 }}
							animate={{ opacity: 1, scale: 1, x: 0, marginRight: getDynamicWidth() / 2 + 8 }}
							exit={{ opacity: 0, scale: 0.4, x: 28 }}
							transition={{
								type: "spring",
								stiffness: 400,
								damping: 31,
								opacity: { duration: 0.15 }
							}}
							onAnimationComplete={() => reportNotchRect.current()}
							onPointerEnter={() => {
								if (shelfHoverTimer.current) clearTimeout(shelfHoverTimer.current);
								shelfHoverTimer.current = setTimeout(() => {
									setIsHovered(true);
									openNotch("shelf");
								}, 150);
							}}
							onPointerLeave={() => {
								if (shelfHoverTimer.current) clearTimeout(shelfHoverTimer.current);
							}}
							onClick={(e) => {
								e.stopPropagation();
								setIsHovered(true);
								openNotch("shelf");
							}}
						>
							<Inbox size={12} strokeWidth={2.4} />
							<span>{shelfItems.length}</span>
						</motion.button>
					)}
				</AnimatePresence>
				{/* Clipboard history bubble on the right of the collapsed pill */}
				<AnimatePresence onExitComplete={() => reportNotchRect.current()}>
					{showClipboardBubble && (
						<motion.button
							key="clipboard-bubble"
							ref={clipboardBubbleRef}
							type="button"
							className={`activity-bubble clipboard-bubble ${isHovered ? "expanded" : ""}`}
							aria-label={`Open clipboard: ${clipboardItems.length} items`}
							style={{ left: "50%" }}
							initial={{ opacity: 0, scale: 0.4, x: -28, marginLeft: clipboardBubbleMarginLeft }}
							animate={{ opacity: 1, scale: 1, x: 0, marginLeft: clipboardBubbleMarginLeft }}
							exit={{ opacity: 0, scale: 0.4, x: -28 }}
							transition={{
								type: "spring",
								stiffness: 400,
								damping: 31,
								opacity: { duration: 0.15 }
							}}
							onAnimationComplete={() => reportNotchRect.current()}
							onPointerEnter={() => {
								if (clipboardHoverTimer.current) clearTimeout(clipboardHoverTimer.current);
								clipboardHoverTimer.current = setTimeout(() => {
									setIsHovered(true);
									openNotch("clipboard");
								}, 150);
							}}
							onPointerLeave={() => {
								if (clipboardHoverTimer.current) clearTimeout(clipboardHoverTimer.current);
							}}
							onClick={(e) => {
								e.stopPropagation();
								setIsHovered(true);
								openNotch("clipboard");
							}}
						>
							<Clipboard size={12} strokeWidth={2.4} />
							<span>{clipboardItems.length}</span>
						</motion.button>
					)}
				</AnimatePresence>
				{/* Music in its own bubble while a timer holds the collapsed pill */}
				<AnimatePresence onExitComplete={() => reportNotchRect.current()}>
					{showMusicBubble && (
						<motion.button
							key="music-bubble"
							ref={musicBubbleRef}
							type="button"
							className={`activity-bubble ${isHovered ? "expanded" : ""}`}
							aria-label={mediaInfo.title ? `Open music: ${mediaInfo.title}` : "Open music"}
							// Anchored at the pill's centre, offset past its right edge.
							style={{ left: "50%" }}
							initial={{ opacity: 0, scale: 0.4, x: -28, marginLeft: musicBubbleMarginLeft }}
							animate={{ opacity: 1, scale: 1, x: 0, marginLeft: musicBubbleMarginLeft }}
							exit={{ opacity: 0, scale: 0.4, x: -28 }}
							transition={{
								type: "spring",
								stiffness: 400,
								damping: 31,
								opacity: { duration: 0.15 }
							}}
							onAnimationComplete={() => reportNotchRect.current()}
							onClick={(e) => {
								e.stopPropagation();
								setIsHovered(true);
								openNotch("music");
							}}
						>
							{settingsAlbumArtEnabled && albumArtUrl ? (
								<img src={albumArtUrl} alt="" draggable={false} />
							) : (
								<Music size={14} strokeWidth={2.2} />
							)}
						</motion.button>
					)}
				</AnimatePresence>
				{/* Unread notification activity bubble on the right of the collapsed pill */}
				<AnimatePresence onExitComplete={() => reportNotchRect.current()}>
					{showNotificationBubble && (
						<motion.button
							key="notification-bubble"
							ref={notificationBubbleRef}
							type="button"
							className={`activity-bubble notification-bubble ${isHovered ? "expanded" : ""}`}
							aria-label={`Unread notifications: ${unreadNotificationCount}`}
							style={{ left: "50%" }}
							initial={{
								opacity: 0,
								scale: 0.4,
								x: -28,
								marginLeft: notificationBubbleMarginLeft
							}}
							animate={{
								opacity: 1,
								scale: 1,
								x: 0,
								marginLeft: notificationBubbleMarginLeft
							}}
							exit={{ opacity: 0, scale: 0.4, x: -28 }}
							transition={{
								type: "spring",
								stiffness: 400,
								damping: 31,
								opacity: { duration: 0.15 }
							}}
							onAnimationComplete={() => reportNotchRect.current()}
							onPointerEnter={() => {
								if (notificationHoverTimer.current) clearTimeout(notificationHoverTimer.current);
								notificationHoverTimer.current = setTimeout(() => {
									setIsHovered(true);
									openNotch("notifications");
								}, 150);
							}}
							onPointerLeave={() => {
								if (notificationHoverTimer.current) clearTimeout(notificationHoverTimer.current);
							}}
							onClick={(e) => {
								e.stopPropagation();
								if (notificationHoverTimer.current) clearTimeout(notificationHoverTimer.current);
								setIsHovered(true);
								setUnreadNotificationCount(0);
								openNotch("notifications");
							}}
						>
							<BellRing size={12} strokeWidth={2.4} />
							<span>{unreadNotificationCount > 0 ? unreadNotificationCount : notificationHistory.length}</span>
						</motion.button>
					)}
				</AnimatePresence>
			</div>
		</div>
	);
}

function BluetoothIcon() {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M6.5 6.5l11 11L12 23V1l5.5 5.5-11 11" />
		</svg>
	);
}

function SettingsIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			style={{ opacity: 0.9 }}
		>
			<circle cx="12" cy="12" r="3" />
			<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
		</svg>
	);
}

function MoonIcon() {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
		</svg>
	);
}

function DockIcon() {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<rect x="2" y="14" width="20" height="8" rx="2" />
			<line x1="6" y1="18" x2="6.01" y2="18" strokeWidth="3.5" strokeLinecap="round" />
			<line x1="10" y1="18" x2="10.01" y2="18" strokeWidth="3.5" strokeLinecap="round" />
			<line x1="14" y1="18" x2="14.01" y2="18" strokeWidth="3.5" strokeLinecap="round" />
			<line x1="18" y1="18" x2="18.01" y2="18" strokeWidth="3.5" strokeLinecap="round" />
		</svg>
	);
}

function NotchIcon() {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M4 3h16a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
			<path d="M9 9v4a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V9" />
		</svg>
	);
}

function BellIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9z" />
			<path d="M13.73 21a2 2 0 0 1-3.46 0" />
		</svg>
	);
}

function ReloadIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
		</svg>
	);
}

function BatterySaverIcon() {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<rect x="2" y="7" width="16" height="10" rx="2" />
			<path d="M22 11v2" />
			<path d="M6 12h4l2-3v6l-2-3H6" />
		</svg>
	);
}

export default App;
