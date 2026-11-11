import { useId, useLayoutEffect, useRef } from "react";
import "./EdgeSurface.css";

type Edge = "top" | "bottom" | "left" | "right";

export interface EdgeSurfaceProps {
	/** The screen edge the surface hangs from. */
	edge: Edge;
	/** Show the concave flares that bridge the pill to the edge. */
	flares?: boolean;
	/** Draw one continuous reflective contour around the surface. */
	reflective?: boolean;
	/** Fluid crest wave when hovering over or spring-loading dock items. */
	wave?: { crestX: number; height: number } | null;
}

const smoothstep = (u: number) => {
	if (u <= 0) return 1;
	if (u >= 1) return 0;
	return 1 - 3 * u * u + 2 * u * u * u;
};

const smoothstepDeriv = (u: number) => {
	if (u <= 0 || u >= 1) return 0;
	return -6 * u + 6 * u * u;
};

/**
 * Background of a surface attached to a screen edge (the notch, the dock, the
 * volume and brightness overlays): the pill plus its two flares, drawn as one
 * layer. Render it as the first child of a positioned, isolated element that
 * sets `--surface-bg`; the pill takes that element's corner radii.
 */
export function EdgeSurface({ edge, flares = true, reflective = false, wave }: EdgeSurfaceProps) {
	const surfaceRef = useRef<HTMLDivElement>(null);
	const rimRef = useRef<SVGPathElement>(null);
	const bevelRef = useRef<SVGPathElement>(null);
	const clipRef = useRef<SVGPathElement>(null);
	const fillRef = useRef<SVGPathElement>(null);
	const gradientRef = useRef<SVGLinearGradientElement>(null);
	const rimGroupRef = useRef<SVGGElement>(null);
	const fadeStartRef = useRef<SVGStopElement>(null);
	const fadeEndRef = useRef<SVGStopElement>(null);
	const gradientId = useId();
	const clipId = `${gradientId}-clip`;
	const fadeId = `${gradientId}-fade`;
	const maskId = `${gradientId}-mask`;

	useLayoutEffect(() => {
		const surface = surfaceRef.current;
		const parent = surface?.parentElement;
		if (!reflective || !surface || !parent || (edge !== "top" && edge !== "bottom")) return;

		// Read the animated CSS radii and untransformed dimensions together.
		// Update only the SVG path: React need not render on each spring frame.
		let previousGeometry = "";
		const draw = () => {
			const style = getComputedStyle(parent);
			const surfaceStyle = getComputedStyle(surface);
			const height = parseFloat(surfaceStyle.height);
			const width = parseFloat(surfaceStyle.width);
			if (!(height > 0 && width > 26)) return;
			const bottom = edge === "bottom";
			const topOffset = bottom ? 24 : 0;
			const left = 13;
			const right = width - 13;
			const radius = (value: string, fallback: number) => {
				const parsed = parseFloat(value);
				const r = isNaN(parsed) || (fallback > 0 && parsed < 12) ? fallback : parsed;
				return Math.min(r, height / 2, (right - left) / 2);
			};
			const rl = radius(bottom ? style.borderTopLeftRadius : style.borderBottomLeftRadius, 18);
			const rr = radius(bottom ? style.borderTopRightRadius : style.borderBottomRightRadius, 18);
			const backLeft = radius(bottom ? style.borderBottomLeftRadius : style.borderTopLeftRadius, 0);
			const backRight = radius(bottom ? style.borderBottomRightRadius : style.borderTopRightRadius, 0);

			const xStart = left + rl;
			const xEnd = right - rr;
			const H = wave && typeof wave.height === "number" ? wave.height : 0;
			const crestX = wave && typeof wave.crestX === "number" ? wave.crestX : null;
			let humpPath = "";

			const waveKey = bottom && H > 0.05 && crestX !== null
				? `${crestX.toFixed(1)},${H.toFixed(1)}`
				: "none";

			const geometry = [width, height, rl, rr, backLeft, backRight, waveKey].join(",");
			if (geometry === previousGeometry) return;
			previousGeometry = geometry;
			let path = "";
			if (!bottom) {
				// Author the notch contour for the top edge.
				path = flares ? `M 0 0 C 10 0 13 3 13 13` : `M ${left} 0`;
				path += ` L ${left} ${height - rl} A ${rl} ${rl} 0 0 0 ${left + rl} ${height}`;
				path += ` L ${right - rr} ${height} A ${rr} ${rr} 0 0 0 ${right} ${height - rr}`;
				path += flares ? ` L ${right} 13 C ${right} 3 ${width - 10} 0 ${width} 0` : ` L ${right} 0`;
				gradientRef.current?.setAttribute("y1", "0");
				gradientRef.current?.setAttribute("y2", String(height));
			} else {
				// Author the dock contour natively for the bottom edge with topOffset headroom.
				if (flares) {
					path = `M 0 ${height} C 10 ${height} ${left} ${height - 3} ${left} ${height - 13}`;
				} else if (backLeft > 0) {
					path = `M ${left + backLeft} ${height} A ${backLeft} ${backLeft} 0 0 1 ${left} ${height - backLeft}`;
				} else {
					path = `M ${left} ${height}`;
				}
				path += ` L ${left} ${topOffset + rl}`;

				const hasWave = H > 0.05 && crestX !== null && xEnd > xStart + 24;
				const k = 0.5522847;
				if (!hasWave) {
					path += rl > 0
						? ` C ${left} ${(topOffset + rl - rl * k).toFixed(1)}, ${(xStart - rl * k).toFixed(1)} ${topOffset}, ${xStart} ${topOffset}`
						: ` L ${left} ${topOffset}`;
					path += ` L ${xEnd.toFixed(1)} ${topOffset}`;
					path += rr > 0
						? ` C ${(xEnd + rr * k).toFixed(1)} ${topOffset}, ${right} ${(topOffset + rr - rr * k).toFixed(1)}, ${right} ${(topOffset + rr).toFixed(1)}`
						: ` L ${right} ${topOffset}`;
				} else {
					// crestX from dock is relative to the dock element (left edge = 0).
					// In EdgeSurface, the dock left edge sits at x = left (13px), so offset by left.
					const surfaceCrestX = Math.max(xStart - 10, Math.min(xEnd + 10, crestX + left));
					const W = 115;

					// Left edge interaction
					const dxLeft = surfaceCrestX - xStart;
					let hStart = 0;
					let slopeStart = 0;
					let x0 = surfaceCrestX - W;
					if (dxLeft < W) {
						const uLeft = Math.max(0, dxLeft / W);
						hStart = H * smoothstep(uLeft);
						slopeStart = (H / W) * smoothstepDeriv(uLeft); // dy/dx < 0 (rising)
						x0 = xStart;
					}

					// Right edge interaction
					const dxRight = xEnd - surfaceCrestX;
					let hEnd = 0;
					let slopeEnd = 0;
					let x1 = surfaceCrestX + W;
					if (dxRight < W) {
						const uRight = Math.max(0, dxRight / W);
						hEnd = H * smoothstep(uRight);
						slopeEnd = -(H / W) * smoothstepDeriv(uRight); // dy/dx > 0 (falling)
						x1 = xEnd;
					}

					// 1. Left corner arc / blend
					const yStart = topOffset - hStart;
					const dyLeft = rl + hStart;
					let leftCorner = "";
					if (rl > 0) {
						const p1_y = topOffset + rl - dyLeft * k;
						const p2_x = xStart - rl * k;
						const p2_y = yStart - slopeStart * (rl * k);
						leftCorner = ` C ${left} ${p1_y.toFixed(1)}, ${p2_x.toFixed(1)} ${p2_y.toFixed(1)}, ${xStart} ${yStart.toFixed(1)}`;
					} else {
						leftCorner = ` L ${left} ${yStart.toFixed(1)}`;
					}
					path += leftCorner;

					// 2. Flat baseline before wave if x0 > xStart
					if (x0 > xStart) {
						path += ` L ${x0.toFixed(1)} ${topOffset}`;
					}

					// 3. Wave left arch
					const spanL = surfaceCrestX - x0;
					let waveArch = "";
					if (spanL > 0.5) {
						const p1_x = x0 + spanL * 0.45;
						const p1_y = yStart + slopeStart * (spanL * 0.45);
						const p2_x = surfaceCrestX - spanL * 0.35;
						const p2_y = topOffset - H;
						waveArch += ` C ${p1_x.toFixed(1)} ${p1_y.toFixed(1)}, ${p2_x.toFixed(1)} ${p2_y.toFixed(1)}, ${surfaceCrestX.toFixed(1)} ${(topOffset - H).toFixed(1)}`;
					}

					// 4. Wave right arch
					const spanR = x1 - surfaceCrestX;
					const yEnd = topOffset - hEnd;
					if (spanR > 0.5) {
						const p1_x = surfaceCrestX + spanR * 0.35;
						const p1_y = topOffset - H;
						const p2_x = x1 - spanR * 0.45;
						const p2_y = yEnd - slopeEnd * (spanR * 0.45);
						waveArch += ` C ${p1_x.toFixed(1)} ${p1_y.toFixed(1)}, ${p2_x.toFixed(1)} ${p2_y.toFixed(1)}, ${x1.toFixed(1)} ${yEnd.toFixed(1)}`;
					}
					path += waveArch;

					// 5. Flat baseline after wave if x1 < xEnd
					if (x1 < xEnd) {
						path += ` L ${xEnd.toFixed(1)} ${topOffset}`;
					}

					// 6. Right corner arc / blend
					const dyRight = rr + hEnd;
					let rightCorner = "";
					if (rr > 0) {
						const p1_x = xEnd + rr * k;
						const p1_y = yEnd + slopeEnd * (rr * k);
						const p2_y = topOffset + rr - dyRight * k;
						rightCorner = ` C ${p1_x.toFixed(1)} ${p1_y.toFixed(1)}, ${right} ${p2_y.toFixed(1)}, ${right} ${(topOffset + rr).toFixed(1)}`;
					} else {
						rightCorner = ` L ${right} ${yEnd.toFixed(1)}`;
					}
					path += rightCorner;

					// 7. Hump fill (covers area above topOffset seamlessly)
					if (hStart > 0.05 && rl > 0) {
						humpPath = `M ${left} ${topOffset + 3} L ${left} ${topOffset + rl}${leftCorner}`;
					} else {
						humpPath = `M ${x0.toFixed(1)} ${topOffset + 3} L ${x0.toFixed(1)} ${topOffset}`;
					}
					humpPath += waveArch;
					if (hEnd > 0.05 && rr > 0) {
						humpPath += rightCorner;
						humpPath += ` L ${right} ${topOffset + 3}`;
					} else {
						humpPath += ` L ${x1.toFixed(1)} ${topOffset + 3}`;
					}
					humpPath += " Z";
				}
				if (flares) {
					path += ` L ${right} ${height - 13} C ${right} ${height - 3} ${width - 10} ${height} ${width} ${height}`;
				} else if (backRight > 0) {
					path += ` L ${right} ${height - backRight} A ${backRight} ${backRight} 0 0 1 ${right - backRight} ${height}`;
				} else {
					path += ` L ${right} ${height}`;
				}
				if (!flares && (backLeft > 0 || backRight > 0)) {
					path += ` L ${left + backLeft} ${height} Z`;
				}
				gradientRef.current?.setAttribute("y1", String(height));
				gradientRef.current?.setAttribute("y2", String(topOffset - (H > 0.05 ? H : 0)));
			}
			// Both contours are authored natively: no SVG coordinate mirroring needed.
			rimGroupRef.current?.setAttribute("transform", "");
			for (const ref of [bevelRef, rimRef, clipRef]) {
				ref.current?.setAttribute("d", path);
			}
			if (fillRef.current) {
				fillRef.current.setAttribute("d", humpPath);
			}

			// Fade only the concave tips, in a fixed 13px span at either end.
			fadeStartRef.current?.setAttribute("offset", String(13 / width));
			fadeEndRef.current?.setAttribute("offset", String(1 - 13 / width));
		};
		// Both observers run before paint. Deferring their work to another RAF
		// makes the SVG fill and rim trail the parent's spring by one frame.
		const resize = new ResizeObserver(draw);
		resize.observe(surface);
		const mutations = new MutationObserver(draw);
		mutations.observe(parent, { attributes: true, attributeFilter: ["style", "class"] });
		draw();
		return () => {
			resize.disconnect();
			mutations.disconnect();
		};
	}, [edge, flares, reflective, wave?.crestX, wave?.height]);

	return (
		<div ref={surfaceRef} className={`edge-surface edge-surface--${edge}${flares ? " show-flares" : ""}`} aria-hidden="true">
			<span className="edge-surface-flare edge-surface-flare--start" />
			<span className="edge-surface-flare edge-surface-flare--end" />
			{reflective && (
				<svg className="edge-surface-rim" width="100%" height="100%">
					<defs>
						<clipPath id={clipId}>
							<path ref={clipRef} />
						</clipPath>
						<linearGradient ref={gradientRef} id={gradientId} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0" stopColor="var(--surface-line)" />
							<stop offset="0.45" stopColor="var(--surface-side-light)" />
							<stop offset="1" stopColor="var(--surface-highlight)" />
						</linearGradient>
						<linearGradient id={fadeId}>
							<stop offset="0" stopColor="white" stopOpacity="0" />
							<stop ref={fadeStartRef} offset="0.1" stopColor="white" />
							<stop ref={fadeEndRef} offset="0.9" stopColor="white" />
							<stop offset="1" stopColor="white" stopOpacity="0" />
						</linearGradient>
						<mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">
							<rect width="100%" height="100%" fill={`url(#${fadeId})`} />
						</mask>
					</defs>
					{/* Fill the wave hump seamlessly with the same solid surface token */}
					<path ref={fillRef} fill="var(--surface-solid)" />
					<g ref={rimGroupRef}>
						{/* A faint inner shoulder makes the rim read as reflected
						    light on a bevel rather than an isolated bright wire. */}
						<path ref={bevelRef} fill="none" stroke={`url(#${gradientId})`} strokeWidth="4" opacity="0.16"
							clipPath={`url(#${clipId})`} mask={flares ? `url(#${maskId})` : undefined} />
						{/* Clip a 2px centred stroke to leave a full 1px INSIDE
						    the fill, including at the viewport's horizontal edges. */}
						<path ref={rimRef} fill="none" stroke={`url(#${gradientId})`} strokeWidth="2"
							clipPath={`url(#${clipId})`} mask={flares ? `url(#${maskId})` : undefined} />
					</g>
				</svg>
			)}
		</div>
	);
}
