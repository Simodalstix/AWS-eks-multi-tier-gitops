// Architecture diagram: one set of facts, two renderers.
// html() feeds the study page ([diagram: architecture]); svg() writes
// diagrams/architecture.svg for the README. scripts/build-study.sh runs both.
// Facts from infrastructure/*.tf, helm-charts/frontend/values.yaml,
// scripts/setup-argocd.sh and the Terraform plan.

export const svgPath = 'diagrams/architecture.svg';

const ARCH = {
  region: 'ap-southeast-2',
  external: [
    { t: 'Users', s: 'HTTP to the ALB' },
    { t: 'Laptop', s: 'terraform, `setup-argocd.sh`, kubectl to the public endpoint' },
    { t: 'GitHub', s: 'repo pulled by Argo CD; Actions validate Terraform' },
  ],
  vpc: 'VPC 10.0.0.0/16, IGW, flow logs to CloudWatch',
  azs: [
    { name: 'ap-southeast-2a', pub: '10.0.64.0/20', priv: '10.0.0.0/20', nat: true },
    { name: 'ap-southeast-2b', pub: '10.0.80.0/20', priv: '10.0.16.0/20' },
    { name: 'ap-southeast-2c', pub: '10.0.96.0/20', priv: '10.0.32.0/20' },
  ],
  pubItems: [['rt', 'ALB node, created by LB controller']],
  natItem: ['nat', 'NAT gateway + EIP (the only one)'],
  privItems: [['', 'worker node(s)'], ['dim', 'egress via NAT in 2a']],
  notes: [
    'Node group `main`: t3.medium Spot, AL2023, 1 to 4 (2 at start) across the 3 private subnets. Each node: kubelet, containerd.',
    'Private egress: 0.0.0.0/0 to the NAT gateway in 2a, then IGW: image pulls (Docker Hub, registry.k8s.io, ECR) and AWS APIs. No VPC endpoints in the repo.',
  ],
  nsLabel: 'Pods on those nodes, by namespace',
  namespaces: [
    { name: 'kube-system', items: [['irsa', 'aws-load-balancer-controller'], ['irsa', 'cluster-autoscaler'], ['', 'metrics-server'], ['dim', 'coredns, aws-node, kube-proxy (EKS bootstrap add-ons)']] },
    { name: 'argocd', items: [['', 'argocd-server, repo-server, application-controller'], ['dim', 'applicationset, notifications, dex, redis']] },
    { name: 'portfolio-apps', items: [['', 'frontend: Deployment, Service, Ingress, HPA'], ['dim', 'nginx:alpine placeholder']] },
    { name: 'monitoring', items: [['', 'Prometheus, Alertmanager, Grafana'], ['dim', 'kube-state-metrics, node-exporter; no volumes']] },
  ],
  side: [
    { lane: 'aws', label: 'EKS control plane, AWS-managed', items: [['', 'API server, etcd, scheduler, controller-manager'], ['', 'Kubernetes 1.35; endpoint public and private'], ['', 'Secrets encrypted with a KMS key'], ['dim', 'Logs api, audit, authenticator to CloudWatch, 90 days']] },
    { lane: 'iam', label: 'IAM', items: [['', 'OIDC provider for IRSA'], ['irsa', 'role to kube-system/aws-load-balancer-controller'], ['irsa', 'role to kube-system/cluster-autoscaler'], ['dim', 'role to ebs-csi-controller-sa: driver not installed'], ['', 'node role: worker, CNI, ECR read-only, SSM']] },
    { lane: 'local', label: 'Other AWS', items: [['', 'ECR eks-portfolio/frontend, backend: unused'], ['', 'CloudWatch Logs: EKS, VPC flow logs']] },
  ],
  flows: [
    'Users to the ALB (public subnets, HTTP :80) to `frontend` pod IPs directly (`target-type: ip`); the Service only tracks endpoints.',
    'All private subnets egress through the one NAT gateway in 2a.',
  ],
  legend: [['irsa', 'IRSA', 'uses an IAM role'], ['rt', 'runtime', 'created by a controller, not Terraform'], ['dim', 'dim', 'defaults or unused']],
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const code = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
const pubItems = (az) => [...ARCH.pubItems, ...(az.nat ? [ARCH.natItem] : [])];

// ---------- HTML (study page, styled by scripts/study/study.css) ----------

export function html() {
  const it = ([k, t]) => `<span class="it${k ? ` it-${k}` : ''}">${code(t)}</span>`;
  const top = ARCH.external.map((e) => `<div class="nd nd-ext"><span class="t">${esc(e.t)}</span><span class="s">${code(e.s)}</span></div>`).join('');
  const azs = ARCH.azs.map((az) => `<div class="az"><span class="az-h">${az.name}</span>`
    + `<div class="sn sn-pub"><span class="sn-h">public ${az.pub}</span>${pubItems(az).map(it).join('')}</div>`
    + `<div class="sn sn-priv"><span class="sn-h">private ${az.priv}</span>${ARCH.privItems.map(it).join('')}</div></div>`).join('');
  const ns = ARCH.namespaces.map((n) => `<div class="ns"><span class="ns-h">${n.name}</span>${n.items.map(it).join('')}</div>`).join('');
  const side = ARCH.side.map((l) => `<div class="lane lane-${l.lane}"><span class="lane-h">${esc(l.label)}</span>${l.items.map(it).join('')}</div>`).join('');
  const legend = ARCH.legend.map(([k, n, d]) => `<span class="it it-${k}">${n}</span> ${esc(d)}`).join(' ');
  return `<div class="arch">
  <div class="arch-top">${top}<span class="region">Region ${ARCH.region}</span></div>
  <div class="arch-main">
    <div class="lane lane-vpc"><span class="lane-h">${esc(ARCH.vpc)}</span>
      <div class="azs">${azs}</div>
      <div class="ns-band"><span class="ns-band-h">${esc(ARCH.nsLabel)}</span>${ns}</div>
      ${ARCH.notes.map((n) => `<p class="cap">${code(n)}</p>`).join('')}
    </div>
    <div class="arch-side">${side}</div>
  </div>
  <ul class="cap flows">${ARCH.flows.map((f) => `<li>${code(f)}</li>`).join('')}</ul>
  <p class="cap legend">${legend}</p>
</div>`;
}

// ---------- SVG (README, colours from study.css tokens) ----------

const SANS = "'Segoe UI', Helvetica, Arial, 'DejaVu Sans', sans-serif";
const MONO = "'DejaVu Sans Mono', Consolas, Menlo, monospace";
// Conservative px per character at 12px; DejaVu is the widest common fallback.
const CW = { sans: 7.0, mono: 7.3 };

function words(text) {
  const out = [];
  String(text).split('`').forEach((part, i) => part.split(/(\s+)/).forEach((w) => { if (w) out.push({ t: w, mono: i % 2 === 1 }); }));
  return out;
}
function wrap(text, width, size) {
  const lines = [[]];
  let w = 0;
  for (const wd of words(text)) {
    const ww = wd.t.length * CW[wd.mono ? 'mono' : 'sans'] * size / 12;
    const space = /^\s+$/.test(wd.t);
    if (space) { if (lines[lines.length - 1].length) { lines[lines.length - 1].push(wd); w += ww; } continue; }
    if (w + ww > width && lines[lines.length - 1].length) {
      const last = lines[lines.length - 1];
      while (last.length && /^\s+$/.test(last[last.length - 1].t)) last.pop();
      lines.push([]);
      w = 0;
    }
    lines[lines.length - 1].push(wd);
    w += ww;
  }
  return lines;
}
function tspans(line) {
  let s = '';
  let cur = null;
  for (const wd of line) {
    if (!cur || cur.mono !== wd.mono) { if (cur) s += seg(cur); cur = { mono: wd.mono, t: '' }; }
    cur.t += wd.t;
  }
  if (cur) s += seg(cur);
  return s;
}
const seg = (c) => (c.mono ? `<tspan font-family="${MONO}" font-size="0.92em">${esc(c.t)}</tspan>` : esc(c.t));

export function svg(T) {
  const W = 1400, P = 16, LW = 1000, GAP = 16, RX = P + LW + GAP, RW = W - P - RX;
  const LH = 15, IP = 4;
  const o = [];
  const rect = (x, y, w, h, a = {}) => o.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${a.rx ?? 5}" fill="${a.fill ?? 'none'}"${a.stroke ? ` stroke="${a.stroke}" stroke-width="${a.sw ?? 1}"` : ''}${a.dash ? ` stroke-dasharray="${a.dash}"` : ''}/>`);
  const text = (x, y, s, a = {}) => o.push(`<text x="${x}" y="${y}" font-size="${a.size ?? 12}" fill="${a.fill ?? T.text}"${a.weight ? ` font-weight="${a.weight}"` : ''}${a.mono ? ` font-family="${MONO}"` : ''}${a.ls ? ` letter-spacing="${a.ls}"` : ''}${a.anchor ? ` text-anchor="${a.anchor}"` : ''}>${a.raw ? s : esc(s)}</text>`);
  const para = (x, y, s, width, a = {}) => {
    const lines = wrap(s, width, a.size ?? 12);
    lines.forEach((l, i) => text(x, y + i * (a.lh ?? LH), tspans(l), { ...a, raw: true }));
    return lines.length * (a.lh ?? LH);
  };
  const itemH = (t, w) => wrap(t, w - 12, 12).length * LH + IP * 2 - 2;
  const item = (x, y, w, [k, t]) => {
    const h = itemH(t, w);
    rect(x, y, w, h, { fill: T.surface2, stroke: k === 'nat' ? T.warn : T.line, dash: k === 'rt' ? '4 3' : null, rx: 3 });
    if (k === 'irsa') rect(x, y, 3, h, { fill: T.purple, rx: 1 });
    para(x + 7, y + IP + 10, t, w - 12, { fill: k === 'nat' ? T.warn : k === 'dim' ? T.muted : T.text, weight: k === 'nat' ? 700 : null });
    return { x, y, w, h };
  };
  const items = (x, y, w, list, gap = 4) => {
    const boxes = [];
    let cy = y;
    for (const i of list) { boxes.push(item(x, cy, w, i)); cy += boxes[boxes.length - 1].h + gap; }
    return { h: cy - y - gap, boxes };
  };
  const listH = (w, list, gap = 4) => list.reduce((s, [, t]) => s + itemH(t, w) + gap, -gap);
  const label = (x, y, s, fill) => text(x, y, s.toUpperCase(), { size: 10.5, weight: 700, fill, ls: 0.7 });
  const laneColor = { aws: T.sand, iam: T.purple, local: T.purple };

  // Title
  text(P, 30, 'Architecture: EKS GitOps lab', { size: 16, weight: 700, fill: T.bright });
  text(P, 48, `Region ${ARCH.region}. Generated by scripts/build-study.sh from scripts/study/diagrams/architecture.mjs, the same source as the study page diagram.`, { size: 11, fill: T.muted });

  // External actors
  let y = 62;
  const exW = (LW - 20) / 3;
  const exH = Math.max(...ARCH.external.map((e) => 8 + 16 + wrap(e.s, exW - 16, 12).length * LH + 6));
  const ext = ARCH.external.map((e, i) => {
    const x = P + i * (exW + 10);
    rect(x, y, exW, exH, { stroke: T.muted, dash: '4 3' });
    text(x + 8, y + 20, e.t, { weight: 700, fill: T.bright });
    para(x + 8, y + 36, e.s, exW - 16, { fill: T.muted });
    return { x, y, w: exW, h: exH };
  });
  y += exH + 38;

  // VPC
  const vpcY = y, ix = P + 10, iw = LW - 20, AZG = 30, colW = (iw - 2 * AZG) / 3;
  const inW = colW - 24;
  const pubH = 20 + Math.max(...ARCH.azs.map((az) => listH(inW, pubItems(az)))) + 8;
  const privH = 20 + listH(inW, ARCH.privItems) + 8;
  const azY = vpcY + 26, pubY = azY + 20, BUS = 30, privY = pubY + pubH + BUS, azH = 20 + pubH + BUS + privH + 6;
  const busY = pubY + pubH + BUS / 2;
  const cols = ARCH.azs.map((az, i) => {
    const x = ix + i * (colW + AZG);
    rect(x, azY, colW, azH, { stroke: T.line, dash: '4 3' });
    text(x + 6, azY + 14, az.name, { size: 11, weight: 700, fill: T.bright, mono: true });
    rect(x + 6, pubY, colW - 12, pubH, { stroke: T.warn, rx: 4 });
    text(x + 12, pubY + 14, `public ${az.pub}`, { size: 11, fill: T.muted, mono: true });
    const pub = items(x + 12, pubY + 20, inW, pubItems(az));
    rect(x + 6, privY, colW - 12, privH, { stroke: T.teal, rx: 4 });
    text(x + 12, privY + 14, `private ${az.priv}`, { size: 11, fill: T.muted, mono: true });
    items(x + 12, privY + 20, inW, ARCH.privItems);
    return { x, pub: pub.boxes, cx: x + colW / 2 };
  });
  let cy = azY + azH + 30;
  label(ix, cy, ARCH.nsLabel, T.teal);
  const nsY = cy + 8, nsW = (iw - 30) / 4;
  const nsH = 22 + Math.max(...ARCH.namespaces.map((n) => listH(nsW - 12, n.items))) + 8;
  const ns = ARCH.namespaces.map((n, i) => {
    const x = ix + i * (nsW + 10);
    rect(x, nsY, nsW, nsH, { stroke: T.teal });
    text(x + 6, nsY + 15, n.name, { size: 11.5, weight: 700, fill: T.teal, mono: true });
    items(x + 6, nsY + 22, nsW - 12, n.items);
    return { x, y: nsY, w: nsW, h: nsH };
  });
  cy = nsY + nsH + 16;
  for (const n of ARCH.notes) cy += para(ix, cy, n, iw, { fill: T.muted }) + 2;
  const vpcH = cy - vpcY;
  rect(P, vpcY, LW, vpcH, { stroke: T.sand, sw: 1.5, rx: 6 });
  label(P + 8, vpcY + 15, ARCH.vpc, T.sand);

  // Right column
  let sy = vpcY;
  for (const l of ARCH.side) {
    const h = 22 + listH(RW - 16, l.items) + 8;
    rect(RX, sy, RW, h, { stroke: laneColor[l.lane], dash: '4 3', rx: 6 });
    label(RX + 8, sy + 15, l.label, laneColor[l.lane]);
    items(RX + 8, sy + 22, RW - 16, l.items);
    sy += h + 10;
  }

  // Arrows. Users to the ALB node in 2a.
  const albA = cols[0].pub[0];
  const ux = ext[0].x + ext[0].w / 2;
  o.push(`<path d="M${ux} ${ext[0].y + ext[0].h} V${albA.y - 2}" stroke="${T.sand}" stroke-width="2" fill="none" marker-end="url(#a-sand)"/>`);
  text(ux + 8, ext[0].y + ext[0].h + 24, 'HTTP :80', { size: 11, fill: T.sand, weight: 700 });
  // ALB to frontend pod IPs, down the 2b/2c gutter.
  const albB = cols[1].pub[0];
  const gx = cols[1].x + colW + AZG / 2;
  const fe = ns.find((_, i) => ARCH.namespaces[i].name === 'portfolio-apps');
  o.push(`<path d="M${albB.x + albB.w} ${albB.y + albB.h / 2} H${gx} V${fe.y - 2}" stroke="${T.sand}" stroke-width="2" fill="none" marker-end="url(#a-sand)"/>`);
  const tl = 'target-type ip: straight to pod IPs';
  const tlw = tl.length * CW.sans * 11 / 12 + 12;
  rect(gx - tlw / 2, azY + azH + 4, tlw, 17, { fill: T.bg, rx: 3 });
  text(gx, azY + azH + 16, tl, { size: 11, fill: T.sand, weight: 700, anchor: 'middle' });
  // Egress bus: every private subnet up to the NAT gateway in 2a.
  const nat = cols[0].pub[cols[0].pub.length - 1];
  const stubs = cols.map((c) => `M${c.cx} ${privY} V${busY}`).join(' ');
  o.push(`<path d="${stubs} M${cols[cols.length - 1].cx} ${busY} H${cols[0].cx} V${nat.y + nat.h + 2}" stroke="${T.teal}" stroke-width="1.5" stroke-dasharray="5 3" fill="none" marker-end="url(#a-teal)"/>`);
  const el = 'egress to NAT in 2a';
  const elw = el.length * CW.sans * 11 / 12 + 12;
  rect(cols[1].cx - elw / 2, busY - 9, elw, 17, { fill: T.bg, rx: 3 });
  text(cols[1].cx, busY + 4, el, { size: 11, fill: T.teal, anchor: 'middle' });

  // Flows and legend
  let fy = Math.max(vpcY + vpcH, sy - 10) + 24;
  for (const f of ARCH.flows) fy += para(P, fy, f, W - 2 * P, { fill: T.text }) + 2;
  fy += 6;
  let lx = P;
  for (const [k, n, d] of ARCH.legend) {
    const w = n.length * CW.sans + 14;
    rect(lx, fy - 12, w, 17, { fill: T.surface2, stroke: T.line, dash: k === 'rt' ? '4 3' : null, rx: 3 });
    if (k === 'irsa') rect(lx, fy - 12, 3, 17, { fill: T.purple, rx: 1 });
    text(lx + 7, fy, n, { fill: k === 'dim' ? T.muted : T.text });
    text(lx + w + 6, fy, d, { fill: T.muted });
    lx += w + 12 + d.length * CW.sans + 18;
  }
  const H = Math.ceil(fy + P);

  const marker = (id, c) => `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${c}"/></marker>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${SANS}" role="img" aria-labelledby="t d">
<title id="t">EKS GitOps lab architecture</title>
<desc id="d">Generated from scripts/study/diagrams/architecture.mjs. ${esc(ARCH.flows.join(' ').replace(/`/g, ''))}</desc>
<defs>${marker('a-sand', T.sand)}${marker('a-teal', T.teal)}</defs>
<rect width="${W}" height="${H}" fill="${T.bg}"/>
${o.join('\n')}
</svg>
`;
}
