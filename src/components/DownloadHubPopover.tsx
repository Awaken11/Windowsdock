import React from "react";
import { motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import {
	DownloadCloud,
	FolderOpen,
	FileDown,
	ExternalLink,
	X,
	CheckCircle2,
	ArrowDown
} from "lucide-react";
import "./DownloadHubPopover.css";

export interface DownloadItem {
	id: string;
	name: string;
	original_name: string;
	path: string;
	bytes_downloaded: number;
	total_bytes?: number;
	speed_bytes_per_sec: number;
	percentage?: number;
	status: string;
	modified_ms: number;
}

export interface DownloadProgressSummary {
	active_count: number;
	total_speed_bps: number;
	overall_percentage?: number;
	active_downloads: DownloadItem[];
	recent_completed: DownloadItem[];
}

interface DownloadHubPopoverProps {
	summary: DownloadProgressSummary;
	anchorX: number;
	scale?: number;
	bottomOffset: number;
	onClose: () => void;
	popoverRef?: React.RefObject<HTMLDivElement | null>;
}

export function formatSpeed(bytesPerSec: number): string {
	if (!bytesPerSec || bytesPerSec <= 0) return "0 KB/s";
	if (bytesPerSec < 1024 * 1024) {
		return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
	}
	return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}

export function formatFileSize(bytes: number): string {
	if (!bytes || bytes <= 0) return "0 B";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function DownloadHubPopover({
	summary,
	anchorX,
	scale = 1,
	bottomOffset,
	onClose,
	popoverRef
}: DownloadHubPopoverProps) {
	const handleOpenFile = (path: string) => {
		invoke("open_download_file", { path }).catch((e) =>
			console.error("Failed to open file:", e)
		);
	};

	const handleShowInFolder = (path: string) => {
		invoke("show_in_folder", { path }).catch((e) =>
			console.error("Failed to show in folder:", e)
		);
	};

	const handleOpenDownloadsFolder = () => {
		invoke("open_dock_extra", { kind: "folder", path: "downloads" }).catch(() =>
			invoke("open_dock_extra", { kind: "folder", path: "shell:Downloads" })
		);
	};

	const hasActive = summary.active_downloads.length > 0;
	const hasCompleted = summary.recent_completed.length > 0;

	return (
		<motion.div
			ref={popoverRef}
			className="download-hub-popover"
			initial={{ opacity: 0, y: 15, scale: 0.96 }}
			animate={{ opacity: 1, y: 0, scale: 1 }}
			exit={{ opacity: 0, y: 10, scale: 0.96 }}
			transition={{ type: "spring", stiffness: 420, damping: 30 }}
			style={{
				left: anchorX,
				bottom: bottomOffset,
				transform: `scale(${scale})`
			}}
			onClick={(e) => e.stopPropagation()}
		>
			<div className="download-hub-header">
				<div className="download-hub-title-group">
					<div className={`download-hub-badge ${hasActive ? "active" : ""}`}>
						<DownloadCloud size={16} />
					</div>
					<div>
						<div className="download-hub-title">Downloads Hub</div>
						{hasActive ? (
							<div className="download-hub-subtitle active">
								{summary.active_count} file{summary.active_count === 1 ? "" : "s"} downloading ·{" "}
								{formatSpeed(summary.total_speed_bps)}
							</div>
						) : (
							<div className="download-hub-subtitle">Universal Download Activity</div>
						)}
					</div>
				</div>

				<div className="download-hub-actions">
					<button
						type="button"
						className="download-hub-icon-btn"
						title="Open Downloads Folder"
						onClick={handleOpenDownloadsFolder}
					>
						<FolderOpen size={14} />
					</button>
					<button
						type="button"
						className="download-hub-icon-btn"
						title="Close"
						onClick={onClose}
					>
						<X size={14} />
					</button>
				</div>
			</div>

			<div className="download-hub-body">
				{hasActive && (
					<div className="download-hub-section">
						<div className="download-hub-section-label">Active Downloads</div>
						<div className="download-hub-list">
							{summary.active_downloads.map((item) => (
								<div key={item.id} className="download-item-card active">
									<div className="download-item-icon">
										<ArrowDown size={14} className="download-pulsing-icon" />
									</div>
									<div className="download-item-info">
										<div className="download-item-name" title={item.name}>
											{item.name}
										</div>
										<div className="download-progress-bar-bg">
											<div
												className="download-progress-bar-fill indeterminate"
												style={{
													width: item.percentage ? `${item.percentage}%` : "100%"
												}}
											/>
										</div>
										<div className="download-item-meta">
											<span>{formatFileSize(item.bytes_downloaded)}</span>
											{item.speed_bytes_per_sec > 0 && (
												<span className="download-speed-tag">
													{formatSpeed(item.speed_bytes_per_sec)}
												</span>
											)}
										</div>
									</div>
								</div>
							))}
						</div>
					</div>
				)}

				<div className="download-hub-section">
					<div className="download-hub-section-label">
						{hasActive ? "Recent Downloads" : "Recent Completed Files"}
					</div>
					{hasCompleted ? (
						<div className="download-hub-list">
							{summary.recent_completed.map((item) => (
								<div
									key={item.id}
									className="download-item-card completed"
									onClick={() => handleOpenFile(item.path)}
								>
									<div className="download-item-icon completed">
										<CheckCircle2 size={14} />
									</div>
									<div className="download-item-info">
										<div className="download-item-name" title={item.name}>
											{item.name}
										</div>
										<div className="download-item-meta">
											<span>{formatFileSize(item.bytes_downloaded)}</span>
										</div>
									</div>
									<div className="download-item-actions">
										<button
											type="button"
											className="download-action-btn"
											title="Show in folder"
											onClick={(e) => {
												e.stopPropagation();
												handleShowInFolder(item.path);
											}}
										>
											<FolderOpen size={13} />
										</button>
										<button
											type="button"
											className="download-action-btn"
											title="Open file"
											onClick={(e) => {
												e.stopPropagation();
												handleOpenFile(item.path);
											}}
										>
											<ExternalLink size={13} />
										</button>
									</div>
								</div>
							))}
						</div>
					) : (
						<div className="download-hub-empty">
							<FileDown size={28} opacity={0.3} />
							<span>No recent downloads detected</span>
						</div>
					)}
				</div>
			</div>

			<div className="download-hub-footer">
				<button
					type="button"
					className="download-hub-footer-btn"
					onClick={handleOpenDownloadsFolder}
				>
					<FolderOpen size={13} />
					<span>Open Downloads Folder</span>
				</button>
			</div>
		</motion.div>
	);
}

