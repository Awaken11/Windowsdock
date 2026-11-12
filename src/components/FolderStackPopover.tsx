import React, { useEffect, useState, useRef, useMemo } from "react";
import { motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import {
	Folder,
	FolderOpen,
	LayoutGrid,
	List as ListIcon,
	X,
	FileText,
	Copy,
	ExternalLink
} from "lucide-react";
import type { DockExtra } from "../dockExtras";
import "./FolderStackPopover.css";

export interface FolderStackItem {
	name: string;
	path: string;
	is_dir: boolean;
	icon: string | null;
	size_bytes?: number;
	modified_ms?: number;
}

interface FolderStackPopoverProps {
	folder: DockExtra;
	anchorX: number;
	scale?: number;
	bottomOffset: number;
	onClose: () => void;
	onOpenFolderInExplorer: (path: string) => void;
	popoverRef?: React.RefObject<HTMLDivElement | null>;
	onLayoutChange?: () => void;
}

function formatBytes(bytes?: number): string {
	if (bytes === undefined || bytes === null) return "Folder";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(ms?: number): string {
	if (!ms) return "";
	const date = new Date(ms);
	const now = new Date();
	const isToday = date.toDateString() === now.toDateString();
	if (isToday) {
		return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	}
	return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function FolderStackPopover({
	folder,
	anchorX,
	scale = 1,
	bottomOffset,
	onClose,
	onOpenFolderInExplorer,
	popoverRef,
	onLayoutChange
}: FolderStackPopoverProps) {
	const [items, setItems] = useState<FolderStackItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [viewMode, setViewMode] = useState<"grid" | "list">(() => {
		return (localStorage.getItem("bloom-folder-stack-view") as "grid" | "list") || "grid";
	});
	const [itemContextMenu, setItemContextMenu] = useState<{
		x: number;
		y: number;
		item: FolderStackItem;
	} | null>(null);

	const localRef = useRef<HTMLDivElement | null>(null);
	const containerRef = popoverRef || localRef;

	// Fetch folder items
	useEffect(() => {
		let isMounted = true;
		setLoading(true);
		invoke<FolderStackItem[]>("get_folder_items", { path: folder.path, limit: 32 })
			.then((res) => {
				if (isMounted) {
					setItems(res || []);
					setLoading(false);
					setTimeout(() => onLayoutChange?.(), 30);
				}
			})
			.catch((err) => {
				console.error("Failed to load folder items:", err);
				if (isMounted) setLoading(false);
			});

		return () => {
			isMounted = false;
		};
	}, [folder.path]);

	// View toggle handler
	const toggleViewMode = (mode: "grid" | "list") => {
		setViewMode(mode);
		localStorage.setItem("bloom-folder-stack-view", mode);
		setTimeout(() => onLayoutChange?.(), 30);
	};

	// Open an individual file
	const handleItemClick = (item: FolderStackItem) => {
		invoke("open_dock_extra", {
			kind: item.is_dir ? "folder" : "file",
			path: item.path
		}).catch(console.error);
		onClose();
	};

	// Right-click context menu on item
	const handleItemContextMenu = (e: React.MouseEvent, item: FolderStackItem) => {
		e.stopPropagation();
		e.preventDefault();
		setItemContextMenu({
			x: e.clientX,
			y: e.clientY,
			item
		});
	};

	// Auto-focus container on mount so keydown events hit this element immediately
	useEffect(() => {
		containerRef.current?.focus();
	}, [containerRef]);

	// Close stack on escape
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				if (itemContextMenu) {
					setItemContextMenu(null);
				} else {
					onClose();
				}
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [onClose, itemContextMenu]);

	// Horizontal positioning clamped within screen bounds
	const leftPosition = useMemo(() => {
		const popoverWidth = viewMode === "grid" ? 340 : 320;
		const halfWidth = popoverWidth / 2;
		const idealLeft = anchorX / scale - halfWidth;
		const minLeft = 16;
		const maxLeft = (window.innerWidth / scale) - popoverWidth - 16;
		return Math.max(minLeft, Math.min(idealLeft, maxLeft));
	}, [anchorX, scale, viewMode]);

	return (
		<motion.div
			ref={containerRef}
			tabIndex={-1}
			className="folder-stack-popover"
			style={{
				left: leftPosition,
				bottom: bottomOffset + 14,
				zoom: scale,
				transformOrigin: "bottom center"
			}}
			initial={{ opacity: 0, scale: 0.96, y: 10 }}
			animate={{ opacity: 1, scale: 1, y: 0 }}
			exit={{ opacity: 0, scale: 0.96, y: 10, transition: { duration: 0.14, ease: "easeOut" } }}
			transition={{ type: "spring", stiffness: 360, damping: 26, mass: 0.8 }}
			onClick={(e) => {
				e.stopPropagation();
				setItemContextMenu(null);
			}}
			onContextMenu={(e) => e.stopPropagation()}
		>
			{/* Popover Header */}
			<div className="folder-stack-header">
				<div className="folder-stack-title-group">
					{folder.icon ? (
						<img src={folder.icon} alt="" className="folder-stack-header-icon" />
					) : (
						<Folder size={18} className="folder-stack-header-icon-fallback" />
					)}
					<div className="folder-stack-title-text">
						<span className="folder-stack-name">{folder.name}</span>
						{!loading && (
							<span className="folder-stack-count">{items.length} items</span>
						)}
					</div>
				</div>

				<div className="folder-stack-actions">
					<button
						className={`folder-stack-icon-btn ${viewMode === "grid" ? "active" : ""}`}
						onClick={() => toggleViewMode("grid")}
						title="Grid View"
					>
						<LayoutGrid size={15} />
					</button>
					<button
						className={`folder-stack-icon-btn ${viewMode === "list" ? "active" : ""}`}
						onClick={() => toggleViewMode("list")}
						title="List View"
					>
						<ListIcon size={15} />
					</button>
					<button
						className="folder-stack-icon-btn"
						onClick={() => onOpenFolderInExplorer(folder.path)}
						title="Open in File Explorer"
					>
						<FolderOpen size={15} />
					</button>
					<button
						className="folder-stack-icon-btn folder-stack-close-btn"
						onClick={onClose}
						title="Close Stack"
					>
						<X size={15} />
					</button>
				</div>
			</div>

			{/* Popover Content */}
			<div className="folder-stack-body">
				{loading ? (
					<div className="folder-stack-loading">
						<div className="folder-stack-spinner" />
						<span>Loading files...</span>
					</div>
				) : items.length === 0 ? (
					<div className="folder-stack-empty">
						<Folder size={28} strokeWidth={1.5} className="folder-stack-empty-icon" />
						<span>This folder is empty</span>
					</div>
				) : viewMode === "grid" ? (
					<div className="folder-stack-grid">
						{items.map((item) => (
							<div
								key={item.path}
								className="folder-stack-grid-item"
								onClick={() => handleItemClick(item)}
								onContextMenu={(e) => handleItemContextMenu(e, item)}
								title={item.name}
							>
								<div className="folder-stack-grid-icon-wrap">
									{item.icon ? (
										<img src={item.icon} alt="" className="folder-stack-grid-icon" draggable={false} />
									) : item.is_dir ? (
										<Folder size={32} className="folder-stack-grid-fallback-folder" />
									) : (
										<FileText size={32} className="folder-stack-grid-fallback-file" />
									)}
								</div>
								<span className="folder-stack-grid-label">{item.name}</span>
							</div>
						))}
					</div>
				) : (
					<div className="folder-stack-list">
						{items.map((item) => (
							<div
								key={item.path}
								className="folder-stack-list-row"
								onClick={() => handleItemClick(item)}
								onContextMenu={(e) => handleItemContextMenu(e, item)}
								title={item.name}
							>
								<div className="folder-stack-list-left">
									{item.icon ? (
										<img src={item.icon} alt="" className="folder-stack-list-icon" draggable={false} />
									) : item.is_dir ? (
										<Folder size={18} className="folder-stack-list-fallback-folder" />
									) : (
										<FileText size={18} className="folder-stack-list-fallback-file" />
									)}
									<span className="folder-stack-list-name">{item.name}</span>
								</div>
								<div className="folder-stack-list-right">
									<span className="folder-stack-list-size">{formatBytes(item.size_bytes)}</span>
									<span className="folder-stack-list-date">{formatDate(item.modified_ms)}</span>
								</div>
							</div>
						))}
					</div>
				)}
			</div>

			{/* Item Context Menu */}
			{itemContextMenu && (
				<div
					className="folder-stack-context-menu"
					style={{
						left: itemContextMenu.x - leftPosition * scale,
						top: itemContextMenu.y - (window.innerHeight - bottomOffset - 400)
					}}
					onClick={(e) => e.stopPropagation()}
				>
					<button
						className="folder-stack-menu-item"
						onClick={() => {
							handleItemClick(itemContextMenu.item);
							setItemContextMenu(null);
						}}
					>
						<ExternalLink size={14} />
						<span>Open</span>
					</button>
					<button
						className="folder-stack-menu-item"
						onClick={() => {
							invoke("show_in_folder", { path: itemContextMenu.item.path }).catch(console.error);
							setItemContextMenu(null);
							onClose();
						}}
					>
						<FolderOpen size={14} />
						<span>Show in File Explorer</span>
					</button>
					<button
						className="folder-stack-menu-item"
						onClick={() => {
							navigator.clipboard.writeText(itemContextMenu.item.path);
							setItemContextMenu(null);
						}}
					>
						<Copy size={14} />
						<span>Copy Full Path</span>
					</button>
				</div>
			)}
		</motion.div>
	);
}
