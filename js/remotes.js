import * as THREE from 'three';
import { deg, shortHex, now } from './utils.js';

function makeLabel(text) {
  const pad = 4, fs = 12, c = document.createElement('canvas'), x = c.getContext('2d');
  x.font = `${fs}px ui-monospace, Menlo, Consolas, monospace`;
  const w = Math.ceil(x.measureText(text).width) + pad * 2, h = fs * 4 + pad * 3; c.width = w; c.height = h;
  x.font = `${fs}px ui-monospace, Menlo, Consolas, monospace`;
  x.fillStyle = 'rgba(0,0,0,.6)'; x.fillRect(0, 0, w, h); x.strokeStyle = 'rgba(255,255,255,.25)'; x.strokeRect(.5, .5, w - 1, h - 1);
  x.fillStyle = '#fff'; x.textBaseline = 'top'; text.split('\n').forEach((line, i) => x.fillText(line, pad, pad + i * (fs + 4)));
  const tex = new THREE.CanvasTexture(c); const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
  const spr = new THREE.Sprite(mat); spr.scale.set(w / 200, h / 200, 1); spr.center.set(0.5, 0); return spr;
}

function smoothAlpha(ratePerSec, dt) {
  return 1 - Math.exp(-Math.max(0, ratePerSec) * Math.max(0, dt));
}

export class Remotes {
  constructor(sceneMgr, heightSampler, avatarFactoryPromise) {
    this.sceneMgr = sceneMgr;
    this.heightAt = heightSampler;
    this.map = new Map();
    this.latest = new Map();
    this.avatarFactoryPromise = avatarFactoryPromise;
  }

  async ensure(pub) {
    if (this.map.has(pub)) return this.map.get(pub);
    const factory = await this.avatarFactoryPromise;
    if (!factory) return null;

    const group = new THREE.Group();
    group.name = `remote-${pub.slice(0,8)}`;
    this.sceneMgr.remoteLayer.add(group);

    const avatar = factory.create();
    group.add(avatar.group);

    const label = makeLabel(shortHex(pub, 8, 6));
    label.position.set(0, avatar.height + 0.35, 0);
    group.add(label);

    const ent = {
      pub, group, avatar, label,
      targetPos: new THREE.Vector3(),
      targetYaw: new THREE.Quaternion(),
      lastPos: new THREE.Vector3(),
      posRate: 16,
      rotRate: 18,
      _labelAt: 0
    };

    ent.avatar.group.getWorldPosition(ent.lastPos);
    ent.targetPos.copy(ent.lastPos);
    ent.targetYaw.copy(ent.avatar.group.quaternion);

    this.map.set(pub, ent);
    return ent;
  }

  async update(pub, pose, info, geo = null) {
    const ent = await this.ensure(pub);
    if (!ent) return;
    const x = pose.p[0], y = pose.p[1], z = pose.p[2];

    const geoEye = Number.isFinite(geo?.eye) ? Number(geo.eye) : null;
    const groundYRaw = Number.isFinite(y)
      ? (Number.isFinite(geoEye) ? y - geoEye : y - 1.6)
      : (this.heightAt ? this.heightAt(x, z) : 0);
    const groundY = Number.isFinite(groundYRaw) ? groundYRaw : 0;

    ent.targetPos.set(x, groundY, z);

    const qFull = new THREE.Quaternion(pose.q[0], pose.q[1], pose.q[2], pose.q[3]);
    const eul = new THREE.Euler().setFromQuaternion(qFull, 'YXZ');
    ent.targetYaw.setFromEuler(new THREE.Euler(0, eul.y, 0, 'YXZ'));

    if (pose.j) ent.avatar.jump();

    const t = now();
    if (t - ent._labelAt > 250) {
      const curY = Number.isFinite(ent.avatar.group.position.y)
        ? ent.avatar.group.position.y
        : (Number.isFinite(ent.targetPos.y) ? ent.targetPos.y : 0);
      const ll = geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lon)
        ? `LL ${geo.lat.toFixed(5)},${geo.lon.toFixed(5)}`
        : null;
      const txt = `${shortHex(pub, 8, 6)}
rtt ${info?.rtt != null ? Math.round(info.rtt) + 'ms' : '—'} • age ${info?.age ?? '—'}
P(${x.toFixed(2)},${curY.toFixed(2)},${z.toFixed(2)})${ll ? `\n${ll}` : ''}
YPR ${deg(eul.y).toFixed(1)}/${deg(eul.x).toFixed(1)}/${deg(eul.z).toFixed(1)}`;
      ent.group.remove(ent.label); ent.label.material.map.dispose(); ent.label.material.dispose();
      ent.label = makeLabel(txt); ent.label.position.set(0, ent.avatar.height + 0.35, 0); ent.group.add(ent.label);
      ent._labelAt = t;
    }

    this.latest.set(pub, { pose, info, ts: t });
  }

  tick(dt) {
    for (const ent of this.map.values()) {
      const pa = ent.avatar.group.position;
      const alphaPos = smoothAlpha(ent.posRate, dt);

      const sx = THREE.MathUtils.lerp(pa.x, ent.targetPos.x, alphaPos);
      const sz = THREE.MathUtils.lerp(pa.z, ent.targetPos.z, alphaPos);
      const sampled = this.heightAt ? this.heightAt(sx, sz) : null;
      const groundY = Number.isFinite(sampled) ? sampled : ent.targetPos.y;

      ent.avatar.setPosition(sx, groundY, sz);

      // Use instance slerp (static may not exist in your build)
      const qc = ent.avatar.group.quaternion;
      const alphaRot = smoothAlpha(ent.rotRate, dt);
      const qNew = qc.clone().slerp(ent.targetYaw, alphaRot);
      ent.avatar.setQuaternion(qNew);

      const pNow = ent.avatar.group.position;
      const dx = pNow.x - ent.lastPos.x, dz = pNow.z - ent.lastPos.z;
      const speed = Math.sqrt(dx * dx + dz * dz) / Math.max(dt, 1e-5);
      ent.lastPos.copy(pNow);
      ent.avatar.setSpeed(speed);

      ent.avatar.update(dt);
    }
  }
}
