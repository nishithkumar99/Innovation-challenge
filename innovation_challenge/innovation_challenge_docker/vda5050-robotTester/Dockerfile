FROM azul/zulu-openjdk:25-latest

RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

ARG APPDIR="/opt/robottester/"
ARG CONFDIR=${APPDIR}/config

WORKDIR ${APPDIR}

ENV SPRING_CONFIG_LOCATION="file:${CONFDIR}/application.properties"
ENV LOGGING_CONFIG="file:${CONFDIR}/logback-spring.xml"

COPY application/*.jar $APPDIR/SAR_MOVE_ROBOT_TESTER.jar
COPY application/config/ $CONFDIR

ENTRYPOINT ["java","-jar"]
CMD ["SAR_MOVE_ROBOT_TESTER.jar"]