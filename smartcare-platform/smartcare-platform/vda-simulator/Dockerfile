FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Install only runtime deps needed by main.py
RUN pip install --no-cache-dir paho-mqtt tomli

# NOTE: these COPY paths are resolved from the build context,
# which should be the simulator source folder.
COPY source ./

CMD ["python", "main.py"]
