import * as path from "path";
import {
  Aws,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Size,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

export class FaceSwapStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const rootDomain = process.env.ROOT_DOMAIN_NAME ?? "aigyeom.com";
    const siteSubdomain = process.env.SITE_SUBDOMAIN ?? "face-swap";
    const siteDomain = `${siteSubdomain}.${rootDomain}`;
    const siteOrigin = `https://${siteDomain}`;
    const uploadsMaxBytes = 10 * 1024 * 1024;
    const metricNamespace = "FaceSwapService";
    const discordWebhookSecretArn = process.env.DISCORD_WEBHOOK_SECRET_ARN ?? "";

    const hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
      domainName: rootDomain,
    });

    const certificate = new acm.DnsValidatedCertificate(this, "SiteCertificate", {
      domainName: siteDomain,
      hostedZone,
      region: "us-east-1",
    });

    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const mediaBucket = new s3.Bucket(this, "MediaBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      cors: [
        {
          allowedHeaders: ["*"],
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: [siteOrigin],
          maxAge: 300,
        },
      ],
      lifecycleRules: [
        {
          enabled: true,
          expiration: Duration.days(1),
          prefix: "uploads/",
        },
        {
          enabled: true,
          expiration: Duration.days(1),
          prefix: "results/",
        },
      ],
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const jobsTable = new dynamodb.Table(this, "JobsTable", {
      partitionKey: { name: "jobId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const publicMetricsTable = new dynamodb.Table(this, "PublicMetricsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const dlq = new sqs.Queue(this, "WorkerDlq", {
      retentionPeriod: Duration.days(14),
    });

    const jobQueue = new sqs.Queue(this, "JobQueue", {
      visibilityTimeout: Duration.minutes(5),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3,
      },
    });

    const alarmTopic = new sns.Topic(this, "AlarmTopic", {
      displayName: `${this.stackName} alerts`,
      topicName: `${this.stackName}-alerts`,
    });

    const apiCode = lambda.Code.fromAsset(path.join(__dirname, "../backend/api"));
    const apiAccessLogGroup = new logs.LogGroup(this, "ApiAccessLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const apiFunctionProps: Omit<lambda.FunctionProps, "handler"> = {
      runtime: lambda.Runtime.PYTHON_3_10,
      code: apiCode,
      timeout: Duration.seconds(15),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_WEEK,
      environment: {
        MEDIA_BUCKET_NAME: mediaBucket.bucketName,
        JOBS_TABLE_NAME: jobsTable.tableName,
        PUBLIC_METRICS_TABLE_NAME: publicMetricsTable.tableName,
        JOB_QUEUE_URL: jobQueue.queueUrl,
        SITE_ORIGIN: siteOrigin,
        UPLOADS_MAX_BYTES: `${uploadsMaxBytes}`,
        DOWNLOAD_URL_EXPIRES_SECONDS: `${15 * 60}`,
        METRIC_NAMESPACE: metricNamespace,
      },
    };

    const presignFn = new lambda.Function(this, "PresignFunction", {
      ...apiFunctionProps,
      handler: "handlers.presign.handler",
    });

    const createJobFn = new lambda.Function(this, "CreateJobFunction", {
      ...apiFunctionProps,
      handler: "handlers.create_job.handler",
    });

    const getJobFn = new lambda.Function(this, "GetJobFunction", {
      ...apiFunctionProps,
      handler: "handlers.get_job.handler",
    });

    const mlFunctionBase: Omit<lambda.DockerImageFunctionProps, "code"> = {
      architecture: lambda.Architecture.X86_64,
      memorySize: 3008,
      timeout: Duration.seconds(120),
      ephemeralStorageSize: Size.mebibytes(2048),
      logRetention: logs.RetentionDays.ONE_WEEK,
      environment: {
        MEDIA_BUCKET_NAME: mediaBucket.bucketName,
        JOBS_TABLE_NAME: jobsTable.tableName,
        PUBLIC_METRICS_TABLE_NAME: publicMetricsTable.tableName,
        MODEL_ROOT: "/opt/insightface",
        SWAPPER_MODEL_PATH: "/opt/insightface/models/inswapper_128.onnx",
        FACE_DET_SIZE: "640",
        MAX_IMAGE_SIDE: "2048",
        UPLOADS_MAX_BYTES: `${uploadsMaxBytes}`,
        METRIC_NAMESPACE: metricNamespace,
        MPLCONFIGDIR: "/tmp/matplotlib",
      },
    };

    const detectFn = new lambda.DockerImageFunction(this, "DetectFunction", {
      ...mlFunctionBase,
      reservedConcurrentExecutions: 5,
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, "../backend/ml"), {
        cmd: ["handlers.detect.handler"],
      }),
    });

    const workerFn = new lambda.DockerImageFunction(this, "WorkerFunction", {
      ...mlFunctionBase,
      reservedConcurrentExecutions: 5,
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, "../backend/ml"), {
        cmd: ["handlers.worker.handler"],
      }),
    });

    workerFn.addEventSource(
      new lambdaEventSources.SqsEventSource(jobQueue, {
        batchSize: 1,
      }),
    );

    mediaBucket.grantPut(presignFn, "uploads/*");
    mediaBucket.grantRead(createJobFn, "uploads/*");
    mediaBucket.grantRead(detectFn, "uploads/*");
    mediaBucket.grantRead(workerFn, "uploads/*");
    mediaBucket.grantReadWrite(workerFn, "results/*");
    mediaBucket.grantRead(getJobFn, "results/*");

    jobsTable.grantReadWriteData(createJobFn);
    jobsTable.grantReadData(getJobFn);
    jobsTable.grantReadWriteData(workerFn);
    publicMetricsTable.grantReadWriteData(createJobFn);
    publicMetricsTable.grantReadWriteData(workerFn);

    jobQueue.grantSendMessages(createJobFn);

    for (const fn of [createJobFn, detectFn, workerFn]) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["cloudwatch:PutMetricData"],
          resources: ["*"],
          conditions: {
            StringEquals: {
              "cloudwatch:namespace": metricNamespace,
            },
          },
        }),
      );
    }

    const api = new apigateway.RestApi(this, "FaceSwapApi", {
      restApiName: "FaceSwapService",
      deployOptions: {
        stageName: "prod",
        throttlingRateLimit: 10,
        throttlingBurstLimit: 20,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: false,
        metricsEnabled: false,
        accessLogDestination: new apigateway.LogGroupLogDestination(apiAccessLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          caller: false,
          user: false,
        }),
      },
      defaultCorsPreflightOptions: {
        allowHeaders: ["Content-Type", "Authorization"],
        allowMethods: ["GET", "POST", "OPTIONS"],
        allowOrigins: [siteOrigin],
      },
    });

    const apiRoot = api.root.addResource("api");
    const uploads = apiRoot.addResource("uploads");
    uploads.addResource("presign").addMethod("POST", new apigateway.LambdaIntegration(presignFn));

    const faces = apiRoot.addResource("faces");
    faces.addResource("detect").addMethod("POST", new apigateway.LambdaIntegration(detectFn));

    const jobs = apiRoot.addResource("jobs");
    jobs.addMethod("POST", new apigateway.LambdaIntegration(createJobFn));
    jobs
      .addResource("{jobId}")
      .addMethod("GET", new apigateway.LambdaIntegration(getJobFn));

    const metricsFn = new lambda.Function(this, "MetricsDashboardFunction", {
      ...apiFunctionProps,
      handler: "handlers.metrics_dashboard.handler",
      environment: {
        ...apiFunctionProps.environment,
        API_NAME: api.restApiName,
        WORKER_FUNCTION_NAME: workerFn.functionName,
        JOB_QUEUE_NAME: jobQueue.queueName,
      },
    });

    publicMetricsTable.grantReadData(metricsFn);
    metricsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cloudwatch:GetMetricData"],
        resources: ["*"],
      }),
    );

    const metrics = apiRoot.addResource("metrics");
    metrics.addResource("dashboard").addMethod("GET", new apigateway.LambdaIntegration(metricsFn));

    const spaRewrite = new cloudfront.Function(this, "SpaRewriteFunction", {
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.startsWith('/api/')) {
    return request;
  }
  if (uri === '/' || !uri.includes('.')) {
    request.uri = '/index.html';
  }
  return request;
}
      `),
    });

    const apiOrigin = new origins.HttpOrigin(
      `${api.restApiId}.execute-api.${this.region}.${Aws.URL_SUFFIX}`,
      {
        originPath: `/${api.deploymentStage.stageName}`,
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      },
    );

    const metricsCachePolicy = new cloudfront.CachePolicy(this, "MetricsCachePolicy", {
      minTtl: Duration.seconds(60),
      defaultTtl: Duration.seconds(60),
      maxTtl: Duration.seconds(60),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      enableAcceptEncodingBrotli: true,
      enableAcceptEncodingGzip: true,
    });

    const distribution = new cloudfront.Distribution(this, "SiteDistribution", {
      domainNames: [siteDomain],
      certificate,
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        functionAssociations: [
          {
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            function: spaRewrite,
          },
        ],
      },
      additionalBehaviors: {
        "api/metrics/*": {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: metricsCachePolicy,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
        "api/*": {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
    });

    new s3deploy.BucketDeployment(this, "FrontendDeployment", {
      destinationBucket: siteBucket,
      sources: [s3deploy.Source.asset(path.join(__dirname, "../frontend"))],
      distribution,
      distributionPaths: ["/*"],
    });

    new route53.ARecord(this, "SiteAliasRecord", {
      zone: hostedZone,
      recordName: siteSubdomain,
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution)),
    });

    new route53.AaaaRecord(this, "SiteAliasRecordIpv6", {
      zone: hostedZone,
      recordName: siteSubdomain,
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution)),
    });

    if (discordWebhookSecretArn) {
      const discordSecret = secretsmanager.Secret.fromSecretCompleteArn(
        this,
        "DiscordWebhookSecret",
        discordWebhookSecretArn,
      );
      const discordNotifierFn = new lambda.Function(this, "DiscordNotifierFunction", {
        runtime: lambda.Runtime.PYTHON_3_10,
        handler: "index.handler",
        code: lambda.Code.fromAsset(path.join(__dirname, "../backend/ops/discord_notifier")),
        timeout: Duration.seconds(30),
        memorySize: 256,
        logRetention: logs.RetentionDays.ONE_WEEK,
        environment: {
          DISCORD_WEBHOOK_SECRET_ARN: discordWebhookSecretArn,
          SITE_URL: siteOrigin,
        },
      });
      discordSecret.grantRead(discordNotifierFn);
      alarmTopic.addSubscription(new snsSubscriptions.LambdaSubscription(discordNotifierFn));
    }

    const apiCountMetric = api.metricCount({ statistic: "Sum", period: Duration.minutes(5) });
    const api4xxMetric = api.metricClientError({ statistic: "Sum", period: Duration.minutes(5) });
    const api5xxMetric = api.metricServerError({ statistic: "Sum", period: Duration.minutes(5) });
    const apiLatencyMetric = api.metricLatency({ statistic: "p95", period: Duration.minutes(5) });
    const detectDurationMetric = detectFn.metricDuration({ statistic: "Average", period: Duration.minutes(5) });
    const detectErrorMetric = detectFn.metricErrors({ statistic: "Sum", period: Duration.minutes(5) });
    const detectThrottleMetric = detectFn.metricThrottles({ statistic: "Sum", period: Duration.minutes(5) });
    const detectConcurrencyMetric = detectFn.metric("ConcurrentExecutions", {
      statistic: "Maximum",
      period: Duration.minutes(5),
    });
    const workerDurationMetric = workerFn.metricDuration({ statistic: "Average", period: Duration.minutes(5) });
    const workerMaxDurationMetric = workerFn.metricDuration({ statistic: "Maximum", period: Duration.minutes(5) });
    const workerErrorMetric = workerFn.metricErrors({ statistic: "Sum", period: Duration.minutes(5) });
    const workerThrottleMetric = workerFn.metricThrottles({ statistic: "Sum", period: Duration.minutes(5) });
    const workerConcurrencyMetric = workerFn.metric("ConcurrentExecutions", {
      statistic: "Maximum",
      period: Duration.minutes(5),
    });
    const queueVisibleMetric = jobQueue.metricApproximateNumberOfMessagesVisible({
      period: Duration.minutes(5),
    });
    const queueAgeMetric = jobQueue.metricApproximateAgeOfOldestMessage({
      period: Duration.minutes(5),
    });
    const dlqVisibleMetric = dlq.metricApproximateNumberOfMessagesVisible({
      period: Duration.minutes(5),
    });
    const jobsCreatedMetric = new cloudwatch.Metric({
      namespace: metricNamespace,
      metricName: "JobsCreated",
      statistic: "Sum",
      period: Duration.minutes(5),
    });
    const jobsCompletedMetric = new cloudwatch.Metric({
      namespace: metricNamespace,
      metricName: "JobsCompleted",
      statistic: "Sum",
      period: Duration.minutes(5),
    });
    const jobsFailedMetric = new cloudwatch.Metric({
      namespace: metricNamespace,
      metricName: "JobsFailed",
      statistic: "Sum",
      period: Duration.minutes(5),
    });
    const detectRuntimeMetric = new cloudwatch.Metric({
      namespace: metricNamespace,
      metricName: "DetectDurationMs",
      statistic: "Average",
      period: Duration.minutes(5),
    });
    const swapRuntimeMetric = new cloudwatch.Metric({
      namespace: metricNamespace,
      metricName: "SwapDurationMs",
      statistic: "Average",
      period: Duration.minutes(5),
    });
    const jobTotalRuntimeMetric = new cloudwatch.Metric({
      namespace: metricNamespace,
      metricName: "JobTotalDurationMs",
      statistic: "Average",
      period: Duration.minutes(5),
    });
    const dashboard = new cloudwatch.Dashboard(this, "OperationsDashboard", {
      dashboardName: `${this.stackName}-operations`,
    });

    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        width: 24,
        height: 3,
        markdown: [
          "## Face Swap Operations",
          `- Site: ${siteOrigin}`,
          `- API: ${siteOrigin}/api`,
          `- Queue: ${jobQueue.queueName}`,
        ].join("\n"),
      }),
      new cloudwatch.GraphWidget({
        title: "API Traffic, Errors, and Latency",
        width: 12,
        left: [apiCountMetric, api4xxMetric, api5xxMetric],
        right: [apiLatencyMetric],
      }),
      new cloudwatch.GraphWidget({
        title: "Detect Lambda",
        width: 12,
        left: [detectDurationMetric, detectErrorMetric, detectThrottleMetric],
        right: [detectConcurrencyMetric],
      }),
      new cloudwatch.GraphWidget({
        title: "Worker Lambda",
        width: 12,
        left: [workerDurationMetric, workerErrorMetric, workerThrottleMetric],
        right: [workerConcurrencyMetric],
      }),
      new cloudwatch.GraphWidget({
        title: "Queue Health",
        width: 12,
        left: [queueVisibleMetric, dlqVisibleMetric, queueAgeMetric],
      }),
      new cloudwatch.GraphWidget({
        title: "Custom Job Metrics",
        width: 12,
        left: [jobsCreatedMetric, jobsCompletedMetric, jobsFailedMetric],
        right: [detectRuntimeMetric, swapRuntimeMetric, jobTotalRuntimeMetric],
      }),
    );

    const alarmAction = new cloudwatchActions.SnsAction(alarmTopic);
    const alarms = [
      new cloudwatch.Alarm(this, "Api5xxAlarm", {
        alarmName: `${this.stackName}-api-5xx`,
        metric: api5xxMetric,
        threshold: 5,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, "WorkerErrorsAlarm", {
        alarmName: `${this.stackName}-worker-errors`,
        metric: workerErrorMetric,
        threshold: 1,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, "WorkerDurationAlarm", {
        alarmName: `${this.stackName}-worker-duration`,
        metric: workerMaxDurationMetric,
        threshold: 90_000,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, "QueueAgeAlarm", {
        alarmName: `${this.stackName}-queue-age`,
        metric: queueAgeMetric,
        threshold: 300,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, "DlqVisibleAlarm", {
        alarmName: `${this.stackName}-dlq-visible`,
        metric: dlqVisibleMetric,
        threshold: 1,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    ];

    for (const alarm of alarms) {
      alarm.addAlarmAction(alarmAction);
      alarm.addOkAction(alarmAction);
    }

    new CfnOutput(this, "SiteUrl", {
      value: siteOrigin,
    });

    new CfnOutput(this, "MediaBucketName", {
      value: mediaBucket.bucketName,
    });

    new CfnOutput(this, "PublicApiBaseUrl", {
      value: `${siteOrigin}/api`,
    });

    new CfnOutput(this, "CloudFrontDistributionId", {
      value: distribution.distributionId,
    });

    new CfnOutput(this, "OperationsDashboardName", {
      value: dashboard.dashboardName,
    });

    new CfnOutput(this, "AlarmTopicArn", {
      value: alarmTopic.topicArn,
    });
  }
}
