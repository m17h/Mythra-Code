//! Bounded, renderer-sequenced timeline rings. No timers or transport work.

use std::collections::{HashMap, VecDeque};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::wire::WireError;

pub(super) const MAX_SUBSCRIPTIONS: usize = 16;
pub(super) const MAX_RESULT_BYTES: usize = 1024 * 1024;
const MAX_RING_BYTES: usize = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;
const MAX_RING_FRAMES: usize = 512;
const MAX_RINGS: usize = 512;
pub(super) const MAX_SAFE_SEQ: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct PublishedFrame {
    pub(crate) seq: u64,
    pub(crate) frame: Value,
}

struct StoredFrame {
    value: PublishedFrame,
    bytes: usize,
    order: u64,
}

pub(super) struct Ring {
    pub(super) epoch: String,
    pub(super) seq: u64,
    frames: VecDeque<StoredFrame>,
    bytes: usize,
}

impl Ring {
    pub(super) fn covers(&self, after: u64, through: u64) -> bool {
        after <= through
            && through <= self.seq
            && (after == through
                || self
                    .frames
                    .front()
                    .is_some_and(|first| first.value.seq <= after.saturating_add(1)))
    }

    pub(super) fn replay(&self, after: u64, through: u64) -> Option<Vec<PublishedFrame>> {
        if !self.covers(after, through) {
            return None;
        }
        let mut size = 0usize;
        let mut frames = Vec::new();
        for stored in self
            .frames
            .iter()
            .filter(|stored| stored.value.seq > after && stored.value.seq <= through)
        {
            size = size.saturating_add(stored.bytes).saturating_add(64);
            if size > MAX_RESULT_BYTES {
                return None;
            }
            frames.push(stored.value.clone());
        }
        Some(frames)
    }

    fn pop(&mut self) -> usize {
        let bytes = self.frames.pop_front().map_or(0, |stored| stored.bytes);
        self.bytes = self.bytes.saturating_sub(bytes);
        bytes
    }
}

#[derive(Clone)]
pub(super) struct Subscription {
    pub(super) link_id: u64,
    pub(super) generation: u64,
    pub(super) revision: u64,
    pub(super) epoch: String,
    /// Last frame put in this subscriber's bounded outgoing queue.
    pub(super) seq: u64,
}

#[derive(Default)]
pub(super) struct Timelines {
    pub(super) rings: HashMap<String, Ring>,
    pub(super) subscribers: HashMap<(String, String), Subscription>,
    bytes: usize,
    order: u64,
}

impl Timelines {
    pub(super) fn count(&self, thread: &str) -> usize {
        self.subscribers
            .keys()
            .filter(|(_, id)| id == thread)
            .count()
    }

    pub(super) fn device_count(&self, device: &str) -> usize {
        self.subscribers
            .keys()
            .filter(|(id, _)| id == device)
            .count()
    }

    pub(super) fn replay(
        &self,
        thread: &str,
        epoch: &str,
        after: u64,
        through: u64,
    ) -> Option<Vec<PublishedFrame>> {
        let ring = self.rings.get(thread)?;
        (ring.epoch == epoch).then_some(())?;
        ring.replay(after, through)
    }

    pub(super) fn can_replay(&self, thread: &str, epoch: &str, after: u64) -> bool {
        self.rings
            .get(thread)
            .is_some_and(|ring| ring.epoch == epoch && ring.replay(after, ring.seq).is_some())
    }

    pub(super) fn retire(&mut self, thread: &str) {
        if let Some(ring) = self.rings.remove(thread) {
            self.bytes = self.bytes.saturating_sub(ring.bytes);
        }
    }

    fn make_room(&mut self, thread: &str) -> Result<(), WireError> {
        if self.rings.contains_key(thread) || self.rings.len() < MAX_RINGS {
            return Ok(());
        }
        // Empty/unsubscribed grace rings can be recreated from a fresh snapshot.
        let old = self.rings.keys().find(|id| self.count(id) == 0).cloned();
        if let Some(old) = old {
            self.retire(&old);
            return Ok(());
        }
        Err(WireError::new(
            "busy",
            "Too many conversations are being shared.",
        ))
    }

    pub(super) fn baseline(
        &mut self,
        thread: &str,
        epoch: &str,
        seq: u64,
    ) -> Result<(), WireError> {
        self.make_room(thread)?;
        if let Some(ring) = self.rings.get(thread) {
            if ring.epoch != epoch || seq > ring.seq {
                return Err(WireError::new(
                    "stale_target",
                    "The conversation changed. Open it again.",
                ));
            }
        } else {
            self.rings.insert(
                thread.to_string(),
                Ring {
                    epoch: epoch.to_string(),
                    seq,
                    frames: VecDeque::new(),
                    bytes: 0,
                },
            );
        }
        Ok(())
    }

    /// Validate the whole batch before changing any ring or sequence.
    pub(super) fn publish(
        &mut self,
        thread: &str,
        epoch: &str,
        frames: Vec<PublishedFrame>,
    ) -> Result<(), WireError> {
        if frames.is_empty() || frames.len() > MAX_RING_FRAMES {
            return Err(WireError::new(
                "internal",
                "That timeline batch is not valid.",
            ));
        }
        let sizes: Vec<usize> = frames
            .iter()
            .map(|item| serde_json::to_vec(item).map(|bytes| bytes.len()))
            .collect::<Result<_, _>>()
            .map_err(|_| WireError::new("internal", "That timeline frame is not valid."))?;
        if sizes.iter().any(|size| *size > MAX_RESULT_BYTES)
            || sizes.iter().sum::<usize>() > super::wire::MAX_FRAME
        {
            return Err(WireError::new(
                "busy",
                "The timeline update is too large. Send a smaller window.",
            ));
        }
        let mut previous = match self.rings.get(thread) {
            Some(ring) if ring.epoch == epoch => ring.seq,
            Some(_) => {
                return Err(WireError::new(
                    "stale_target",
                    "The timeline epoch changed. Retire the old publisher first.",
                ))
            }
            None => frames[0].seq.checked_sub(1).ok_or_else(|| {
                WireError::new(
                    "stale_target",
                    "Timeline sequence numbers must increase by one.",
                )
            })?,
        };
        for frame in &frames {
            if frame.seq > MAX_SAFE_SEQ || previous.checked_add(1) != Some(frame.seq) {
                return Err(WireError::new(
                    "stale_target",
                    "Timeline sequence numbers must increase by one.",
                ));
            }
            previous = frame.seq;
        }
        self.make_room(thread)?;
        let ring = self
            .rings
            .entry(thread.to_string())
            .or_insert_with(|| Ring {
                epoch: epoch.to_string(),
                seq: frames[0].seq - 1,
                frames: VecDeque::new(),
                bytes: 0,
            });
        for (value, bytes) in frames.into_iter().zip(sizes) {
            self.order = self.order.saturating_add(1);
            ring.seq = value.seq;
            ring.bytes += bytes;
            self.bytes += bytes;
            ring.frames.push_back(StoredFrame {
                value,
                bytes,
                order: self.order,
            });
            while ring.frames.len() > MAX_RING_FRAMES || ring.bytes > MAX_RING_BYTES {
                self.bytes = self.bytes.saturating_sub(ring.pop());
            }
        }
        while self.bytes > MAX_TOTAL_BYTES {
            let oldest = self
                .rings
                .iter()
                .filter_map(|(id, ring)| ring.frames.front().map(|frame| (id.clone(), frame.order)))
                .min_by_key(|(_, order)| *order)
                .map(|(id, _)| id);
            let Some(oldest) = oldest else {
                break;
            };
            if let Some(ring) = self.rings.get_mut(&oldest) {
                self.bytes = self.bytes.saturating_sub(ring.pop());
            }
        }
        Ok(())
    }
}
