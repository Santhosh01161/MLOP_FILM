# 🎬 FILM-SECURE: End-to-End MLOps Pipeline for AI Video Frame Interpolation

> An automated cloud pipeline that doubles the frame rate of low-FPS videos using deep learning — built as a complete MLOps system on AWS.

**Asian Institute of Technology — MLOps Course, 2026**  
Santhosh Kanaga Sabapathy (`st126107@ait.asia`) · Peerapat Ngamsanga (`st125842@ait.asia`)

---

## 📌 What This Project Does

FILM-SECURE takes a low-frame-rate video (e.g. 15 FPS surveillance footage) and uses an AI model to generate intermediate frames, doubling the frame rate to 30 FPS — automatically, via a cloud pipeline, with no manual intervention.

**Example:** Upload a 5-second, 15 FPS video → get back a 30 FPS version with 74 AI-generated frames inserted.

---

## 🏗️ System Architecture

The system has two independent pipelines that share Amazon S3 as the central storage layer.

### Inference Pipeline (Production)
```
User Browser
    │
    ▼
AWS Amplify (Frontend — HTML/CSS/JS)
    │  POST /api/upload
    ▼
Amazon ECS Fargate (FastAPI — main.py)
    ├── Upload video → S3 (uploads/)
    └── Push job message → SQS
    │
    ▼
Amazon SQS (film-jobs queue)
    │  Event trigger
    ▼
AWS Lambda (lambda_function.py)
    │  Start Processing Job
    ▼
AWS SageMaker Processing (inference_job.py — ml.m5.xlarge CPU)
    ├── Download video from S3
    ├── Run FILM frame interpolation
    └── Upload enhanced video → S3 (enhanced/)
    │
    ▼
DynamoDB (job status) + S3 (enhanced video output)
    │  GET /api/job/{id} polling
    ▼
User downloads enhanced video
```

### Training Pipeline
```
GitHub Repo
    │  push to main
    ▼
GitHub Actions (CI/CD)
    │
    ▼
SageMaker Pipeline
    ├── Data Preprocessing Job (Vimeo-90K → frame triplets → S3)
    ├── Model Training Job (PyTorch + MLflow tracking)
    ├── Model Evaluation (PSNR / SSIM)
    └── Model Registration (SageMaker Model Registry)
```

---

## 🧠 The AI Model

The frame interpolation model is a **Pyramid Multi-Scale Flow Estimator** with four components:

| Component | Role |
|---|---|
| Feature Encoder | Extracts features from F1 and F3 at 3 spatial scales |
| Optical Flow Net | Predicts motion vectors coarse-to-fine |
| Warping Layer | Shifts pixels from input frames toward intermediate position |
| Synthesis Net (U-Net) | Cleans up artefacts and produces final frame |

### Ablation Study Results (Vimeo-90K Test Set)

| Experiment | Architecture | Loss | PSNR (dB) | SSIM |
|---|---|---|---|---|
| 1 | Original Flow-Based | L1 | 33.39 | 0.9237 |
| 2 | No-Warp Ablation | L1 | 30.52 | 0.8886 |
| 3 | Perceptual Flow-Based | L1 + VGG | 32.14 | 0.9252 |
| 4 | Softmax Splatting | L1 + VGG | 33.03 | 0.9343 |
| **5** | **Pyramid Multi-Scale** | **Multi-Scale L1** | **35.15** | **0.9681** |

Architecture E (Pyramid) is the production model.

---

## 🗂️ Repository Structure

```
MLOP_FILM/
│
├── amplify-frontend/          # Static frontend deployed on AWS Amplify
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   └── amplify.yml
│
├── template/                  # Jinja2 templates (for local FastAPI serving)
│   └── index.html
│
├── static/                    # Static assets (for local FastAPI serving)
│   ├── app.js
│   └── style.css
│
├── main.py                    # FastAPI backend (ECS Fargate)
├── worker.py                  # Redis-based worker (local dev only)
├── film_inferencer.py         # FILM model + video processing
├── inference.py               # interpolate_video() function
├── inference_job.py           # SageMaker Processing entry point
├── lambda_function.py         # AWS Lambda — triggers SageMaker
├── pyramidModel.py            # Pyramid model architecture
├── datasets.py                # Vimeo-90K dataset loader
├── train.py                   # Training loop
├── loss.py                    # Loss functions (L1, VGG, Multi-Scale)
│
└── README.md
```

---

## 🛠️ Technology Stack

| Tool | Role | Status |
|---|---|---|
| Python / PyTorch | Model implementation | ✅ Done |
| FastAPI | Backend REST API | ✅ Done |
| HTML / CSS / JS | Frontend interface | ✅ Done |
| AWS Amplify | Frontend hosting (CDN + HTTPS) | ✅ Done |
| Amazon ECS Fargate | Backend container hosting | ✅ Done |
| Amazon S3 | Video + data storage | ✅ Done |
| Amazon SQS | Job queue (film-jobs) | ✅ Done |
| AWS Lambda | SageMaker job trigger | ✅ Done |
| SageMaker Processing | CPU inference (ml.m5.xlarge) | ✅ Done |
| Amazon DynamoDB | Job status tracking | ✅ Done |
| MLflow | Experiment tracking | ✅ Done |
| DVC | Dataset versioning (S3 remote) | ✅ Done |
| GitHub Actions | CI/CD automation | ✅ Done |

---

## 🚀 API Endpoints

The FastAPI backend (`main.py`) exposes three endpoints:

### `POST /api/upload`
Upload a video for enhancement.
```
Body: multipart/form-data
  - file: video file (MP4, AVI, MOV, MKV — max 2 GB)
  - interp_factor: 2 (fixed)
  - quality: "high" (fixed)

Response: { "job_id": "abc-123" }
```

### `GET /api/job/{job_id}`
Poll for job status (called every 3 seconds by the frontend).
```
Response: {
  "job_id": "abc-123",
  "status": "queued | preprocessing | processing | completed | failed",
  "progress": 0-100,
  "message": "...",
  "download_url": "https://..." (only when completed)
}
```

### `GET /api/download/{job_id}`
Get a fresh pre-signed S3 download URL (valid 1 hour).

---

## 💰 Cost Analysis

| Scenario | Compute Time | Cost per Video |
|---|---|---|
| 5-second clip (75 frames) | ~4–6 min | ~$0.003 |
| 30-second clip | ~25–35 min | ~$0.016 |
| Idle (no requests) | — | **$0.00** |

- Instance: `ml.m5.xlarge` (4 vCPU, 16 GB RAM) at $0.23/hr billed per second
- Compared to a persistent EC2 at $0.192/hr, the serverless approach saves ~90% for typical academic usage (10–20 videos/day)

---

## ⚙️ System Constraints

| Constraint | Value |
|---|---|
| Input resolution | 224 × 224 (resized internally) |
| Interpolation factor | Fixed 2× |
| Max clip duration | 5 sec (optimal) / 30 sec (max) |
| Supported formats | MP4, AVI, MOV, MKV |
| Max file size | 2 GB |
| Inference hardware | CPU only (ml.m5.xlarge) |
| End-to-end latency | ~6–10 minutes |

---

## 🏃 Running Locally

### Prerequisites
```bash
git clone https://github.com/Santhosh01161/MLOPS_film-secure.git
cd MLOPS_film-secure
```

### Install dependencies
```bash
uv add fastapi uvicorn jinja2 python-multipart redis boto3 \
        torch torchvision opencv-python-headless numpy Pillow
```

### Run the FastAPI server
```bash
uv run uvicorn main:app --reload --port 8000
```

Visit `http://localhost:8000` to see the website.

> **Note:** Video processing requires AWS credentials and a running SageMaker setup. For local testing, the UI loads fully but job submission requires the full AWS stack.

---

## 🌐 Live Deployment

| Component | URL |
|---|---|
| Frontend (Amplify) | `https://frontend.dyuogleidh3h1.amplifyapp.com/` |
| Backend (ECS Fargate) | `https://vf-22de0586fba54274b7d8b1daba37623d.ecs.us-east-1.on.aws` |

---

## 📊 Training the Model

The training pipeline is triggered automatically via GitHub Actions on every push to `main`. To run training manually:

```bash
# Install training dependencies
pip install torch torchvision scikit-image numpy opencv-python

# Run training
python train.py
```

Training configuration:
- Dataset: Vimeo-90K Triplet
- Epochs: 20
- Batch size: 8
- Learning rate: 1e-4 (Adam)
- Resolution: 224 × 224

---

## 📝 References

1. F. Reda et al., "FILM: Frame Interpolation for Large Motion," ICLR, 2022.
2. S. Niklaus and F. Liu, "Softmax Splatting for Video Frame Interpolation," CVPR, 2020.
3. T. Xue et al., "Video Enhancement with Task-Oriented Flow," IJCV, 2019.
4. M. Zaharia et al., "Accelerating the Machine Learning Lifecycle with MLflow," 2018.

---

## 👥 Team

| Name | Student ID | Email | Role |
|---|---|---|---|
| Santhosh Kanaga Sabapathy | st126107 | st126107@ait.asia | FILM Inference, Frontend |
| Peerapat Ngamsanga | st125842 | st125842@ait.asia | Backend, AWS Infrastructure |

**Asian Institute of Technology**  
Department of Data Sciences and Artificial Intelligence  
School of Engineering and Technology, Thailand
