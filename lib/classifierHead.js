const fs = require('fs');
const path = require('path');
const tf = require('@tensorflow/tfjs');

class ClassifierHead {
  constructor(modelSaveDir) {
    this.modelSaveDir = modelSaveDir || path.resolve(__dirname, '../data/classifier-head');
    this.model = null;
    this.isTraining = false;
    this.lastTrainedAt = null;
    this.loocvF1 = null;
    this.precision = null;
    this.recall = null;
    this.trainingDataSize = 0;
    this.savedReferenceHash = null;
    this.currentReferenceHash = null;
  }

  buildModel() {
    const model = tf.sequential();

    model.add(tf.layers.dense({
      inputShape: [128],
      units: 32,
      activation: 'relu',
      kernelRegularizer: tf.regularizers.l2({ l2: 0.01 })
    }));

    model.add(tf.layers.dropout({ rate: 0.4 }));

    model.add(tf.layers.dense({
      units: 1,
      activation: 'sigmoid'
    }));

    model.compile({
      optimizer: tf.train.adam(0.001),
      loss: 'binaryCrossentropy',
      metrics: ['accuracy']
    });

    return model;
  }

  /**
   * Leave-One-Out Cross-Validation for small datasets (< 30 samples).
   */
  async loocvEvaluate(allX, allY) {
    let truePos = 0, falsePos = 0, trueNeg = 0, falseNeg = 0;

    for (let i = 0; i < allX.length; i++) {
      const trainX = [...allX.slice(0, i), ...allX.slice(i + 1)];
      const trainY = [...allY.slice(0, i), ...allY.slice(i + 1)];
      const testX = allX[i];
      const testY = allY[i];

      const foldModel = this.buildModel();
      const xTensor = tf.tensor2d(trainX.map(d => Array.from(d)));
      const yTensor = tf.tensor2d(trainY.map(v => [v]));

      await foldModel.fit(xTensor, yTensor, {
        epochs: 25,
        batchSize: Math.min(8, trainX.length),
        shuffle: true,
        verbose: 0
      });

      const input = tf.tensor2d([Array.from(testX)]);
      const predTensor = foldModel.predict(input);
      const predProb = predTensor.dataSync()[0];
      const pred = predProb >= 0.5 ? 1 : 0;

      if (pred === 1 && testY === 1) truePos++;
      else if (pred === 1 && testY === 0) falsePos++;
      else if (pred === 0 && testY === 0) trueNeg++;
      else if (pred === 0 && testY === 1) falseNeg++;

      xTensor.dispose();
      yTensor.dispose();
      input.dispose();
      predTensor.dispose();
      foldModel.dispose();
    }

    const precision = (truePos + falsePos) > 0 ? truePos / (truePos + falsePos) : 0;
    const recall = (truePos + falseNeg) > 0 ? truePos / (truePos + falseNeg) : 0;
    const f1 = (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    return { f1, precision, recall, truePos, falsePos, trueNeg, falseNeg };
  }

  /**
   * Stratified 5-Fold Cross-Validation for larger datasets (>= 30 samples).
   */
  async kFoldEvaluate(allX, allY, k = 5) {
    const posIndices = allY.map((y, i) => (y === 1 ? i : -1)).filter(i => i !== -1);
    const negIndices = allY.map((y, i) => (y === 0 ? i : -1)).filter(i => i !== -1);

    // Shuffle
    const shuffle = arr => arr.slice().sort(() => Math.random() - 0.5);
    const shuffledPos = shuffle(posIndices);
    const shuffledNeg = shuffle(negIndices);

    const folds = Array.from({ length: k }, () => []);
    shuffledPos.forEach((idx, i) => folds[i % k].push(idx));
    shuffledNeg.forEach((idx, i) => folds[i % k].push(idx));

    let truePos = 0, falsePos = 0, trueNeg = 0, falseNeg = 0;

    for (let f = 0; f < k; f++) {
      const valIndices = new Set(folds[f]);
      const trainX = [];
      const trainY = [];
      const valX = [];
      const valY = [];

      allX.forEach((x, idx) => {
        if (valIndices.has(idx)) {
          valX.push(x);
          valY.push(allY[idx]);
        } else {
          trainX.push(x);
          trainY.push(allY[idx]);
        }
      });

      const foldModel = this.buildModel();
      const xTensor = tf.tensor2d(trainX.map(d => Array.from(d)));
      const yTensor = tf.tensor2d(trainY.map(v => [v]));

      await foldModel.fit(xTensor, yTensor, {
        epochs: 50,
        batchSize: Math.min(16, trainX.length),
        shuffle: true,
        verbose: 0
      });

      const valTensor = tf.tensor2d(valX.map(d => Array.from(d)));
      const predsTensor = foldModel.predict(valTensor);
      const preds = predsTensor.dataSync();

      for (let i = 0; i < valY.length; i++) {
        const pred = preds[i] >= 0.5 ? 1 : 0;
        const actual = valY[i];
        if (pred === 1 && actual === 1) truePos++;
        else if (pred === 1 && actual === 0) falsePos++;
        else if (pred === 0 && actual === 0) trueNeg++;
        else if (pred === 0 && actual === 1) falseNeg++;
      }

      xTensor.dispose();
      yTensor.dispose();
      valTensor.dispose();
      predsTensor.dispose();
      foldModel.dispose();
    }

    const precision = (truePos + falsePos) > 0 ? truePos / (truePos + falsePos) : 0;
    const recall = (truePos + falseNeg) > 0 ? truePos / (truePos + falseNeg) : 0;
    const f1 = (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    return { f1, precision, recall, truePos, falsePos, trueNeg, falseNeg };
  }

  /**
   * Train on accumulated feedback.
   * Performs cross-validation, validates against F1 >= 0.80 gate,
   * then trains final production model and persists to disk.
   */
  async train(positives, negatives, referenceDescriptors = []) {
    if (this.isTraining) return null;
    this.isTraining = true;

    try {
      const allPositives = [...referenceDescriptors, ...positives];
      const allNegatives = [...negatives];

      if (allPositives.length < 5 || allNegatives.length < 3) {
        return {
          success: false,
          reason: `Insufficient data: need >= 5 positives (have ${allPositives.length}) and >= 3 negatives (have ${allNegatives.length}).`
        };
      }

      const allX = [...allPositives, ...allNegatives];
      const allY = [
        ...allPositives.map(() => 1),
        ...allNegatives.map(() => 0)
      ];

      // Cross-validation
      const cvResult = allX.length < 30
        ? await this.loocvEvaluate(allX, allY)
        : await this.kFoldEvaluate(allX, allY, 5);

      // Quality Gate: Macro F1 >= 0.80
      if (cvResult.f1 < 0.80) {
        return {
          success: false,
          f1: cvResult.f1,
          precision: cvResult.precision,
          recall: cvResult.recall,
          reason: `Quality gate not met: F1 is ${(cvResult.f1 * 100).toFixed(1)}% (minimum is 80.0%). More diverse feedback required.`
        };
      }

      // If previous model exists, dispose it before building new one
      if (this.model) {
        this.model.dispose();
        this.model = null;
      }

      // Train production model on ALL data
      this.model = this.buildModel();
      const X = tf.tensor2d(allX.map(d => Array.from(d)));
      const y = tf.tensor2d(allY.map(v => [v]));

      await this.model.fit(X, y, {
        epochs: 40,
        batchSize: Math.min(16, Math.max(4, Math.floor(allX.length / 2))),
        shuffle: true,
        verbose: 0
      });

      X.dispose();
      y.dispose();

      this.lastTrainedAt = new Date().toISOString();
      this.loocvF1 = cvResult.f1;
      this.precision = cvResult.precision;
      this.recall = cvResult.recall;
      this.trainingDataSize = allX.length;

      await this.save();

      return {
        success: true,
        f1: cvResult.f1,
        precision: cvResult.precision,
        recall: cvResult.recall,
        positiveCount: allPositives.length,
        negativeCount: allNegatives.length
      };
    } finally {
      this.isTraining = false;
    }
  }

  /**
   * Predict child probability for an array of 128-d face descriptors in a single batch.
   */
  predictBest(descriptors) {
    if (!this.model || !descriptors || descriptors.length === 0) return null;

    const input = tf.tensor2d(descriptors.map(d => Array.from(d)));
    const predsTensor = this.model.predict(input);
    const probs = predsTensor.dataSync();

    input.dispose();
    predsTensor.dispose();

    let maxProb = 0;
    let maxIdx = 0;
    for (let i = 0; i < probs.length; i++) {
      if (probs[i] > maxProb) {
        maxProb = probs[i];
        maxIdx = i;
      }
    }

    return { probability: maxProb, faceIndex: maxIdx };
  }

  async save() {
    if (!this.model) return;

    if (!fs.existsSync(this.modelSaveDir)) {
      fs.mkdirSync(this.modelSaveDir, { recursive: true });
    }

    // Save topology and weights via custom IOHandler
    await this.model.save(tf.io.withSaveHandler(async (artifacts) => {
      fs.writeFileSync(
        path.join(this.modelSaveDir, 'model-topology.json'),
        JSON.stringify(artifacts.modelTopology)
      );
      fs.writeFileSync(
        path.join(this.modelSaveDir, 'weights-specs.json'),
        JSON.stringify(artifacts.weightSpecs)
      );
      fs.writeFileSync(
        path.join(this.modelSaveDir, 'weights.bin'),
        Buffer.from(artifacts.weightData)
      );
      return {
        modelArtifactsInfo: {
          dateSaved: new Date(),
          modelTopologyType: 'JSON'
        }
      };
    }));

    this.saveMetadata();
  }

  saveMetadata() {
    const meta = {
      lastTrainedAt: this.lastTrainedAt,
      loocvF1: this.loocvF1,
      precision: this.precision,
      recall: this.recall,
      trainingDataSize: this.trainingDataSize,
      referenceHash: this.currentReferenceHash || this.savedReferenceHash
    };

    if (!fs.existsSync(this.modelSaveDir)) {
      fs.mkdirSync(this.modelSaveDir, { recursive: true });
    }

    fs.writeFileSync(
      path.join(this.modelSaveDir, 'metadata.json'),
      JSON.stringify(meta, null, 2),
      'utf-8'
    );
  }

  async load() {
    const topologyPath = path.join(this.modelSaveDir, 'model-topology.json');
    const specsPath = path.join(this.modelSaveDir, 'weights-specs.json');
    const binPath = path.join(this.modelSaveDir, 'weights.bin');
    const metaPath = path.join(this.modelSaveDir, 'metadata.json');

    if (!fs.existsSync(topologyPath) || !fs.existsSync(specsPath) || !fs.existsSync(binPath)) {
      return false;
    }

    try {
      const topology = JSON.parse(fs.readFileSync(topologyPath, 'utf-8'));
      const weightSpecs = JSON.parse(fs.readFileSync(specsPath, 'utf-8'));
      const weightData = new Uint8Array(fs.readFileSync(binPath)).buffer;

      if (this.model) {
        this.model.dispose();
      }

      this.model = await tf.loadLayersModel(tf.io.fromMemory({
        modelTopology: topology,
        weightSpecs,
        weightData
      }));

      this.model.compile({
        optimizer: tf.train.adam(0.001),
        loss: 'binaryCrossentropy',
        metrics: ['accuracy']
      });

      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        this.lastTrainedAt = meta.lastTrainedAt || null;
        this.loocvF1 = meta.loocvF1 !== undefined ? meta.loocvF1 : null;
        this.precision = meta.precision !== undefined ? meta.precision : null;
        this.recall = meta.recall !== undefined ? meta.recall : null;
        this.trainingDataSize = meta.trainingDataSize || 0;
        this.savedReferenceHash = meta.referenceHash || null;
      }

      return true;
    } catch (err) {
      console.warn('Failed to load classifier head model from disk:', err.message);
      return false;
    }
  }

  isReady() {
    return Boolean(this.model && this.loocvF1 !== null && this.loocvF1 >= 0.80);
  }

  isModelStale(currentRefHash) {
    if (!this.savedReferenceHash || !currentRefHash) return false;
    return this.savedReferenceHash !== currentRefHash;
  }

  reset() {
    if (this.model) {
      this.model.dispose();
      this.model = null;
    }
    this.lastTrainedAt = null;
    this.loocvF1 = null;
    this.precision = null;
    this.recall = null;
    this.trainingDataSize = 0;
    this.savedReferenceHash = null;

    try {
      if (fs.existsSync(this.modelSaveDir)) {
        fs.rmSync(this.modelSaveDir, { recursive: true, force: true });
      }
    } catch {}
  }

  getDiagnostics() {
    return {
      hasModel: this.model !== null,
      isTraining: this.isTraining,
      lastTrainedAt: this.lastTrainedAt,
      loocvF1: this.loocvF1,
      precision: this.precision,
      recall: this.recall,
      trainingDataSize: this.trainingDataSize,
      isReady: this.isReady()
    };
  }
}

module.exports = ClassifierHead;
