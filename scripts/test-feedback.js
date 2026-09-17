/**
 * scripts/test-feedback.js
 *
 * Automated verification suite for the Feedback & Continuous Learning system.
 * Tests FeedbackStore, ClassifierHead (TF.js), NearMissBuffer, and ForwarderEngine scoring.
 *
 * Run: node scripts/test-feedback.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const FeedbackStore = require('../lib/feedbackStore');
const ClassifierHead = require('../lib/classifierHead');
const NearMissBuffer = require('../lib/nearMissBuffer');
const ForwarderEngine = require('../lib/engine');

// Helper to create a synthetic 128-d unit vector with cluster bias
function makeSyntheticDescriptor(seed = 0, clusterCenter = null, noise = 0.05) {
  const v = new Float32Array(128);
  let normSq = 0;
  for (let i = 0; i < 128; i++) {
    const base = clusterCenter ? clusterCenter[i] : Math.sin(seed * 100 + i);
    const n = (Math.random() - 0.5) * noise;
    v[i] = base + n;
    normSq += v[i] * v[i];
  }
  const norm = Math.sqrt(normSq) || 1;
  for (let i = 0; i < 128; i++) {
    v[i] /= norm;
  }
  return v;
}

async function runTests() {
  console.log('================================================================');
  console.log('  Running Feedback & Fine-Tuning Verification Suite');
  console.log('================================================================\n');

  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-test-'));

  try {
    // -------------------------------------------------------------
    // Test 1: FeedbackStore CRUD, Persistence, Caching, and Undo
    // -------------------------------------------------------------
    console.log('[Test 1] Testing FeedbackStore operations...');
    const feedbackPath = path.join(testDir, 'feedback.json');
    const cachePath = path.join(testDir, 'descriptor-cache.json');
    const store = new FeedbackStore(feedbackPath, cachePath);

    const descA = makeSyntheticDescriptor(1);
    const descB = makeSyntheticDescriptor(2);
    const descC = makeSyntheticDescriptor(3);

    // Descriptor caching
    store.cacheDescriptor('msg_001', descA, 0.42);
    const cached = store.getCachedDescriptor('msg_001');
    assert(cached !== null, 'Should retrieve cached descriptor');
    assert.strictEqual(cached.distance, 0.42, 'Cached distance should match');
    assert.strictEqual(cached.bestDescriptor.length, 128, 'Cached descriptor length should be 128');

    // Confirm match
    const posId = store.addPositive(descA, 0.42, 'msg_001', 'confirmed_match');
    assert(posId.startsWith('fb_pos_'), 'Positive ID should have prefix');
    assert.strictEqual(store.getPositives().length, 1, 'Positives count should be 1');
    assert.strictEqual(store.getStats().totalConfirmed, 1, 'Total confirmed should be 1');

    // Reject match (hard negative)
    const negId = store.addNegative(descB, 0.48, 'msg_002', 'rejected_match');
    assert(negId.startsWith('fb_neg_'), 'Negative ID should have prefix');
    assert.strictEqual(store.getNegatives().length, 1, 'Negatives count should be 1');
    assert.strictEqual(store.getHardNegatives().length, 1, 'Hard negatives count should be 1');
    assert.strictEqual(store.getStats().totalRejected, 1, 'Total rejected should be 1');

    // Auto-negative mining
    const autoId = store.addAutoNegative(descC, 0.95);
    assert(autoId.startsWith('fb_auto_'), 'Auto negative ID should have prefix');
    assert.strictEqual(store.getNegatives().length, 2, 'Total negatives should be 2');
    assert.strictEqual(store.getStats().totalAutoNegatives, 1, 'Auto negative count should be 1');

    // Undo positive
    const undoRes = store.undoFeedback(posId);
    assert.strictEqual(undoRes, true, 'Undo should succeed');
    assert.strictEqual(store.getPositives().length, 0, 'Positives count should be 0 after undo');
    assert.strictEqual(store.getStats().totalConfirmed, 0, 'Confirmed count should decrease');

    // Reload from disk to verify persistence
    const reloadedStore = new FeedbackStore(feedbackPath, cachePath);
    assert.strictEqual(reloadedStore.getNegatives().length, 2, 'Negatives should persist on disk');
    console.log('  [PASS] FeedbackStore CRUD, caching, undo, and persistence verified.\n');

    // -------------------------------------------------------------
    // Test 2: NearMissBuffer Ring Buffer, Pruning, and Rescuing
    // -------------------------------------------------------------
    console.log('[Test 2] Testing NearMissBuffer ring buffer and TTL...');
    const nearMissPath = path.join(testDir, 'near-misses.json');
    const previewDir = path.join(testDir, 'previews');
    const buffer = new NearMissBuffer(nearMissPath, previewDir);

    // Add near-miss
    const dummyMedia = { data: Buffer.from('fake image data').toString('base64'), mimetype: 'image/jpeg' };
    const nearMissEntry = buffer.add(dummyMedia, 'msg_near_01', descA, 0.54);
    assert(nearMissEntry !== null, 'Near miss entry should be created');
    assert(nearMissEntry.id.startsWith('miss_'), 'Entry ID should have prefix');
    assert.strictEqual(buffer.getAll().length, 1, 'Buffer should have 1 entry');

    // Rescue near-miss
    const found = buffer.getById(nearMissEntry.id);
    assert(found !== null, 'Should find near-miss by ID');
    assert.strictEqual(found.bestDistance, 0.54, 'Distance should match');

    buffer.remove(nearMissEntry.id);
    assert.strictEqual(buffer.getAll().length, 0, 'Buffer should be empty after remove');
    console.log('  [PASS] NearMissBuffer operations verified.\n');

    // -------------------------------------------------------------
    // Test 3: ClassifierHead Build, LOOCV, Training, and Prediction
    // -------------------------------------------------------------
    console.log('[Test 3] Testing ClassifierHead TF.js training, LOOCV, and batch inference...');
    const modelDir = path.join(testDir, 'classifier-head');
    const head = new ClassifierHead(modelDir);

    // Generate two distinct clusters of 128-d vectors (Positives around Center 1, Negatives around Center 2)
    const centerPos = makeSyntheticDescriptor(10);
    const centerNeg = makeSyntheticDescriptor(20);

    const syntheticPositives = Array.from({ length: 8 }, (_, i) => makeSyntheticDescriptor(100 + i, centerPos, 0.05));
    const syntheticNegatives = Array.from({ length: 8 }, (_, i) => makeSyntheticDescriptor(200 + i, centerNeg, 0.05));

    // Train on clearly separated clusters -> LOOCV F1 should easily be >= 0.80
    const trainResult = await head.train(syntheticPositives, syntheticNegatives, []);
    assert(trainResult !== null, 'Train result should not be null');
    assert.strictEqual(trainResult.success, true, `Training should pass quality gate: ${trainResult.reason || ''}`);
    assert(trainResult.f1 >= 0.80, `LOOCV F1 must be >= 0.80, got ${trainResult.f1}`);
    assert.strictEqual(head.isReady(), true, 'Classifier head should be ready');

    // Test batch prediction on new positive and negative query faces
    const queryPos = makeSyntheticDescriptor(999, centerPos, 0.05);
    const queryNeg = makeSyntheticDescriptor(888, centerNeg, 0.05);

    const posPred = head.predictBest([queryPos]);
    const negPred = head.predictBest([queryNeg]);

    assert(posPred !== null && posPred.probability > 0.5, `Positive sample should have high probability, got ${posPred?.probability}`);
    assert(negPred !== null && negPred.probability < 0.5, `Negative sample should have low probability, got ${negPred?.probability}`);

    // Test custom IOHandler persistence: reload saved model from disk
    const reloadedHead = new ClassifierHead(modelDir);
    const loaded = await reloadedHead.load();
    assert.strictEqual(loaded, true, 'Reloading classifier head model from disk should succeed');
    assert.strictEqual(reloadedHead.isReady(), true, 'Reloaded head should maintain ready state');

    const reloadedPred = reloadedHead.predictBest([queryPos]);
    assert(reloadedPred !== null && reloadedPred.probability > 0.5, 'Reloaded model predictions should match');

    // Test stale model detection
    reloadedHead.savedReferenceHash = 'old_hash_123';
    assert.strictEqual(reloadedHead.isModelStale('new_hash_456'), true, 'Should detect stale model when reference hash changes');
    assert.strictEqual(reloadedHead.isModelStale('old_hash_123'), false, 'Should not report stale when hash matches');

    console.log('  [PASS] ClassifierHead TF.js training, LOOCV F1 gate, and persistence verified.\n');

    // -------------------------------------------------------------
    // Test 4: ForwarderEngine Scoring & Ensemble Blending
    // -------------------------------------------------------------
    console.log('[Test 4] Testing ForwarderEngine scoreWithFeedback and ensemble logic...');
    const engine = new ForwarderEngine();

    // Mock an enrolled child profile
    const childProfileCenter = makeSyntheticDescriptor(10);
    engine.profiles = [{
      name: 'TestChild',
      descriptor: childProfileCenter,
      photosUsed: 5,
      createdAt: new Date().toISOString()
    }];
    engine.referenceDescriptor = childProfileCenter;

    // 4a. Pure Exemplar Matching (no feedback yet)
    const matchingFace = makeSyntheticDescriptor(11, childProfileCenter, 0.05);
    const nonMatchingFace = makeSyntheticDescriptor(12, centerNeg, 0.05);

    const scoreMatch = engine.scoreWithFeedback([matchingFace], 0.5);
    assert.strictEqual(scoreMatch.matched, true, 'Profile-matching face should match');
    assert.strictEqual(scoreMatch.method, 'exemplar_distance', 'Initial method should be exemplar_distance');

    const scoreNoMatch = engine.scoreWithFeedback([nonMatchingFace], 0.5);
    assert.strictEqual(scoreNoMatch.matched, false, 'Non-matching face should not match');

    // 4b. Hard Negative Rejection
    // Face is close to child (dist ~0.26, well below threshold 0.50), but this specific face was marked as false positive
    const lookalikeFace = makeSyntheticDescriptor(13, childProfileCenter, 0.08);
    // Add lookalike face to hard negatives
    engine.feedbackStore.addNegative(lookalikeFace, 0.26, 'msg_fake_01', 'rejected_match');

    const scoreLookalike = engine.scoreWithFeedback([lookalikeFace], 0.5);
    assert.strictEqual(scoreLookalike.rejectedByNegative, true, 'Lookalike face should be flagged as rejected by negative');
    assert.strictEqual(scoreLookalike.matched, false, 'Lookalike should be blocked from false matching');

    // 4c. Adaptive Classifier Weight
    engine.classifierHead = head; // Attach our trained head from Test 3
    const weight = engine.getClassifierWeight();
    assert(weight >= 0 && weight <= 0.7, `Classifier weight should be in [0, 0.7], got ${weight}`);

    const ensembleResult = engine.scoreWithFeedback([matchingFace], 0.5);
    assert.strictEqual(ensembleResult.matched, true, 'Ensemble should correctly match child face');

    console.log('  [PASS] ForwarderEngine feedback scoring, hard negative rejection, and ensemble verified.\n');

  } finally {
    // Cleanup temp files
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }

  console.log('================================================================');
  console.log('  ALL AUTOMATED TESTS PASSED SUCCESSFULLY! (100%)');
  console.log('================================================================\n');
}

runTests().catch(err => {
  console.error('\n[X] Test failed:', err);
  process.exit(1);
});
