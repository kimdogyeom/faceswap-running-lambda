FROM public.ecr.aws/lambda/python:3.10

ENV MODEL_ROOT=/opt/insightface
ENV INSIGHTFACE_HOME=/opt/insightface
ENV PYTHONUNBUFFERED=1

RUN yum install -y gcc gcc-c++ make && yum clean all

COPY requirements.txt ${LAMBDA_TASK_ROOT}/requirements.txt
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt

COPY download_models.py ${LAMBDA_TASK_ROOT}/download_models.py
RUN python ${LAMBDA_TASK_ROOT}/download_models.py

COPY handlers ${LAMBDA_TASK_ROOT}/handlers
COPY shared ${LAMBDA_TASK_ROOT}/shared

CMD ["handlers.detect.handler"]
