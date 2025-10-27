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
  constructor(sceneMgr, heightSampler, avatarFactoryPromise, opts = {}) {
    this.sceneMgr = sceneMgr;
    this.heightAt = heightSampler;
    this.map = new Map();
    this.latest = new Map();
    this.avatarFactoryPromise = avatarFactoryPromise;

    // NEW: self-awareness
    this.selfPub = typeof opts.selfPub === 'string' ? opts.selfPub.toLowerCase() : null;
    this.isSelf = (pub) => {
      if (!pub || !this.selfPub) return false;
      return String(pub).toLowerCase() === this.selfPub;
    };
  }


  async ensure(pub, alias) {
    // NEW: never create a "remote" for self
    if (this.isSelf(pub)) {
      // If a stale self-entry exists (from an earlier bug), remove it now.
      const stale = this.map.get(pub);
      if (stale) {
        try {
          this.sceneMgr.remoteLayer.remove(stale.group);
          if (stale.label) {
            stale.group.remove(stale.label);
            stale.label.material.map.dispose();
            stale.label.material.dispose();
          }
        } catch { }
        this.map.delete(pub);
      }
      return null;
    }

    if (this.map.has(pub)) {
      if (typeof alias === 'string') this.setAlias(pub, alias);
      return this.map.get(pub);
    }
    const factory = await this.avatarFactoryPromise;
    if (!factory) return null;

    const group = new THREE.Group();
    group.name = `remote-${pub.slice(0, 8)}`;
    this.sceneMgr.remoteLayer.add(group);

    const avatar = factory.create();
    group.add(avatar.group);

    const ent = {
      pub,
      group,
      avatar,
      label: null,
      alias: typeof alias === 'string' ? alias.trim() : '',
      targetPos: new THREE.Vector3(),
      targetYaw: new THREE.Quaternion(),
      lastPos: new THREE.Vector3(),
      posRate: 16,
      rotRate: 18,
      _labelAt: 0,
      _labelText: '',
      isHovered: false
    };

    ent.avatar.group.getWorldPosition(ent.lastPos);
    ent.targetPos.copy(ent.lastPos);
    ent.targetYaw.copy(ent.avatar.group.quaternion);

    this.map.set(pub, ent);
    this._refreshLabel(ent, this._composeLabelText(ent), now());
    return ent;
  }

  setSelfPub(pub) {
    const next = typeof pub === 'string' ? pub.toLowerCase() : null;
    if (this.selfPub === next) return;
    this.selfPub = next;
    // Clean up any mistakenly-spawned self remote
    if (next && this.map.has(next)) {
      const ent = this.map.get(next);
      try {
        this.sceneMgr.remoteLayer.remove(ent.group);
        if (ent.label) {
          ent.group.remove(ent.label);
          ent.label.material.map.dispose();
          ent.label.material.dispose();
        }
      } catch { }
      this.map.delete(next);
    }
  }

  setAlias(pub, alias) {
    if (!pub) return;
    const ent = this.map.get(pub);
    if (!ent) return;
    const norm = typeof alias === 'string' ? alias.trim() : '';
    if (ent.alias === norm) return;
    ent.alias = norm;
    this._refreshLabel(ent, this._composeLabelText(ent), now());
  }

  clearHover() {
    for (const ent of this.map.values()) {
      if (!ent.isHovered) continue;
      ent.isHovered = false;
      if (ent.label) ent.label.visible = false;
    }
  }

  updateHover(raycaster) {
    if (!raycaster) return;
    let hovered = null;
    let minDist = Infinity;
    for (const ent of this.map.values()) {
      const root = ent.avatar?.group;
      if (!root) continue;
      const hits = raycaster.intersectObject(root, true);
      if (hits.length && hits[0].distance < minDist) {
        hovered = ent;
        minDist = hits[0].distance;
      }
    }
    for (const ent of this.map.values()) {
      const isTarget = ent === hovered;
      if (ent.isHovered === isTarget) continue;
      ent.isHovered = isTarget;
      if (ent.label) ent.label.visible = isTarget;
    }
  }

  _composeLabelText(ent, stats = {}) {
    if (!ent) return '';
    const base = ent.alias && ent.alias.length ? ent.alias : shortHex(ent.pub, 8, 6);
    const lines = [base];
    if (Array.isArray(stats.meta) && stats.meta.length) lines.push(stats.meta.join(' • '));
    if (stats.pose) lines.push(stats.pose);
    if (stats.geo) lines.push(stats.geo);
    if (stats.attitude) lines.push(stats.attitude);
    return lines.join('\n');
  }

  _refreshLabel(ent, text, timestamp = now()) {
    if (!ent) return;
    const finalText = text || this._composeLabelText(ent);
    if (ent.label && ent._labelText === finalText) {
      ent._labelAt = timestamp;
      ent.label.visible = ent.isHovered;
      return;
    }
    if (ent.label) {
      ent.group.remove(ent.label);
      ent.label.material.map.dispose();
      ent.label.material.dispose();
    }
    ent.label = makeLabel(finalText);
    ent.label.position.set(0, ent.avatar.height + 0.35, 0);
    ent.label.visible = ent.isHovered;
    ent.group.add(ent.label);
    ent._labelText = finalText;
    ent._labelAt = timestamp;
  }

  async update(pub, pose, info, geo = null) {
    const ent = await this.ensure(pub);
    if (!ent) return;
    const x = pose.p[0], y = pose.p[1], z = pose.p[2];

    ent.avatar.setCrouch(!!pose.c);
    if (ent.avatar?.setHeadLook) {
      if (pose.xr && typeof pose.xr === 'object') {
        ent.avatar.setHeadLook({
          active: (pose.xr.active ?? 1) !== 0,
          yaw: Number.isFinite(pose.xr.headYaw) ? pose.xr.headYaw : null,
          pitch: Number.isFinite(pose.xr.headPitch) ? pose.xr.headPitch : null,
          roll: Number.isFinite(pose.xr.headRoll) ? pose.xr.headRoll : null
        });
      } else {
        ent.avatar.setHeadLook({ active: false });
      }
    }

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
      const metaParts = [];
      if (info?.rtt != null) metaParts.push(`rtt ${Math.round(info.rtt)}ms`);
      if (info?.age) metaParts.push(`age ${info.age}`);
      const poseLine = `P(${x.toFixed(2)},${curY.toFixed(2)},${z.toFixed(2)})`;
      const geoLine = geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lon)
        ? `LL ${geo.lat.toFixed(5)},${geo.lon.toFixed(5)}`
        : null;
      const attitudeLine = `YPR ${deg(eul.y).toFixed(1)}/${deg(eul.x).toFixed(1)}/${deg(eul.z).toFixed(1)}`;
      const labelText = this._composeLabelText(ent, {
        meta: metaParts,
        pose: poseLine,
        geo: geoLine,
        attitude: attitudeLine
      });
      this._refreshLabel(ent, labelText, t);
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

      if (ent.label) ent.label.visible = ent.isHovered;
      ent.avatar.update(dt);
    }
  }
}
