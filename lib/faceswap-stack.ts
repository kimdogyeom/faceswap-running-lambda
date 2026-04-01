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
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";

export class FaceSwapStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const rootDomain = process.env.ROOT_DOMAIN_NAME ?? "aigyeom.com";
    const siteSubdomain = process.env.SITE_SUBDOMAIN ?? "face-swap";
    const siteDomain = `${siteSubdomain}.${rootDomain}`;
    const siteOrigin = `https://${siteDomain}`;
    const deploymentRegion = props?.env?.region ?? process.env.CDK_DEFAULT_REGION ?? "us-east-1";
    const enableEdgeWaf = deploymentRegion === "us-east-1";
    const uploadsMaxBytes = 10 * 1024 * 1024;

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

    const apiCode = lambda.Code.fromAsset(path.join(__dirname, "../backend/api"));

    const apiFunctionProps: Omit<lambda.FunctionProps, "handler"> = {
      runtime: lambda.Runtime.PYTHON_3_10,
      code: apiCode,
      timeout: Duration.seconds(15),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_WEEK,
      environment: {
        MEDIA_BUCKET_NAME: mediaBucket.bucketName,
        JOBS_TABLE_NAME: jobsTable.tableName,
        JOB_QUEUE_URL: jobQueue.queueUrl,
        SITE_ORIGIN: siteOrigin,
        UPLOADS_MAX_BYTES: `${uploadsMaxBytes}`,
        DOWNLOAD_URL_EXPIRES_SECONDS: `${15 * 60}`,
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

    const mlFunctionBase = {
      architecture: lambda.Architecture.X86_64,
      memorySize: 3008,
      timeout: Duration.seconds(120),
      ephemeralStorageSize: Size.mebibytes(2048),
      logRetention: logs.RetentionDays.ONE_WEEK,
      environment: {
        MEDIA_BUCKET_NAME: mediaBucket.bucketName,
        JOBS_TABLE_NAME: jobsTable.tableName,
        MODEL_ROOT: "/opt/insightface",
        SWAPPER_MODEL_PATH: "/opt/insightface/models/inswapper_128.onnx",
        FACE_DET_SIZE: "640",
        MAX_IMAGE_SIDE: "2048",
        UPLOADS_MAX_BYTES: `${uploadsMaxBytes}`,
      },
    };

    const detectFn = new lambda.DockerImageFunction(this, "DetectFunction", {
      ...mlFunctionBase,
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, "../backend/ml"), {
        cmd: ["handlers.detect.handler"],
      }),
    });

    const workerFn = new lambda.DockerImageFunction(this, "WorkerFunction", {
      ...mlFunctionBase,
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

    jobQueue.grantSendMessages(createJobFn);

    const api = new apigateway.RestApi(this, "FaceSwapApi", {
      restApiName: "FaceSwapService",
      deployOptions: {
        stageName: "prod",
        throttlingRateLimit: 10,
        throttlingBurstLimit: 20,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: false,
        metricsEnabled: true,
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

    const apiWebAcl = new wafv2.CfnWebACL(this, "ApiWebAcl", {
      defaultAction: { allow: {} },
      scope: "REGIONAL",
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "faceSwapApiAcl",
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: "RateLimit",
          priority: 1,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              aggregateKeyType: "IP",
              limit: 1000,
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "faceSwapApiRateLimit",
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    new wafv2.CfnWebACLAssociation(this, "ApiWebAclAssociation", {
      resourceArn: api.deploymentStage.stageArn,
      webAclArn: apiWebAcl.attrArn,
    });

    const edgeWebAcl =
      enableEdgeWaf
        ? new wafv2.CfnWebACL(this, "SiteWebAcl", {
            defaultAction: { allow: {} },
            scope: "CLOUDFRONT",
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: "faceSwapEdgeAcl",
              sampledRequestsEnabled: true,
            },
            rules: [
              {
                name: "RateLimit",
                priority: 1,
                action: { block: {} },
                statement: {
                  rateBasedStatement: {
                    aggregateKeyType: "IP",
                    limit: 1000,
                  },
                },
                visibilityConfig: {
                  cloudWatchMetricsEnabled: true,
                  metricName: "faceSwapEdgeRateLimit",
                  sampledRequestsEnabled: true,
                },
              },
            ],
          })
        : undefined;

    const distribution = new cloudfront.Distribution(this, "SiteDistribution", {
      domainNames: [siteDomain],
      certificate,
      webAclId: edgeWebAcl?.attrArn,
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
  }
}
