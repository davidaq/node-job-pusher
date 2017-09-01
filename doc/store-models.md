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
  detail      : string,
  retried     : number,
  createtime  : number,
}
```

## queue

```
{
  _id       : string,   // detail._id
  topic     : string,   // topic._id + [0|1|2]
  seq       : number,
}
```
