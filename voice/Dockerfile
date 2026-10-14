FROM pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime
RUN apt-get update && apt-get install -y --no-install-recommends libsndfile1 ffmpeg && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user PATH=/home/user/.local/bin:$PATH
WORKDIR /home/user/app
COPY --chown=user requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt
COPY --chown=user app.py .
# Load the model at build time would bloat the image; it downloads on first start instead.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
