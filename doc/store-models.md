## topic

```
{
  _id       : string,
  retries   : number,
  backoff   : number,
  timeout   : number,
  worker    : []{
    concurrency     : number,
    url             : string,
  },
}
```

## counter

```
{
  _id       : string,   // topic._id + [0|1|2]
  pending   : number,
  running   : number,
  done      : number,
}
```

## detail

```
{
  _id         : string,
  payload     : string,
  retried     : number,
  priority    : number,
  topic       : string,
  createtime  : number,
  output      : string, // base64
  outputType  : string, // content-type
  status      : string, // [pending|running|success|failure]
}
```

## queue

```
{
  _id       : string,   // detail._id
  topic     : string,   // topic._id + [0|1|2]
  seq       : number,
  working   : number,   // [0|1]
}
```
